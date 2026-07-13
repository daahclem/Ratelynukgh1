require("dotenv").config();
const fs = require("fs");
const { chromium } = require("playwright");

const INGEST_URL = process.env.INGEST_URL;
const INGEST_TOKEN = process.env.INGEST_TOKEN;
const HEADLESS = true; // set true in GitHub Actions later

function currencyForDestination(destination) {
  if (destination === "GH") return "GHS";
  if (destination === "NG") return "NGN";
  return "GHS";
}

async function postQuote(payload) {
  if (
    !INGEST_URL ||
    !INGEST_TOKEN ||
    INGEST_URL.includes("your-quoteops-app-url") ||
    INGEST_TOKEN.includes("your_secret_token_here")
  ) {
    console.log("INGEST_URL or INGEST_TOKEN not set. Quote extracted locally only:");
    console.log(payload);
    return;
  }

  const res = await fetch(INGEST_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${INGEST_TOKEN}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ingest failed: ${res.status} ${text}`);
  }
}

function saveDebugText(provider, text) {
  const safe = provider
    .replace(/\s+/g, "-")
    .toLowerCase();

  const file = `debug-${safe}.txt`;

  fs.writeFileSync(
    file,
    String(text || ""),
    "utf8"
  );

  return file;
}

async function saveScreenshot(page, provider) {
  const safe = provider.replace(/\s+/g, "-").toLowerCase();
  const file = `debug-${safe}.png`;

  try {
    await page.screenshot({
      path: file,
      fullPage: false,
      timeout: 10000,
    });
    return file;
  } catch (err) {
    console.error(`Could not capture screenshot for ${provider}: ${err.message}`);
    return "screenshot-not-captured";
  }
}

function parseLocaleNumber(value) {
  if (value === null || value === undefined) return null;

  let str = String(value).trim();
  if (!str) return null;

  str = str.replace(/[^\d,.-]/g, "");

  const hasComma = str.includes(",");
  const hasDot = str.includes(".");

  if (hasComma && hasDot) {
    const lastComma = str.lastIndexOf(",");
    const lastDot = str.lastIndexOf(".");

    if (lastComma > lastDot) {
      str = str.replace(/\./g, "").replace(",", ".");
    } else {
      str = str.replace(/,/g, "");
    }
  } else if (hasComma) {
    if (/,\d{1,2}$/.test(str)) {
      str = str.replace(",", ".");
    } else {
      str = str.replace(/,/g, "");
    }
  } else if (hasDot) {
    const parts = str.split(".");
    if (parts.length > 2) {
      const decimal = parts.pop();
      str = parts.join("") + "." + decimal;
    }
  }

  const num = Number(str);
  return Number.isFinite(num) ? num : null;
}

function extractRateFromText(text, currency) {
  const cleaned = text.replace(/,/g, "").replace(/\s+/g, " ");

  const patterns = [
    new RegExp(`1\\s*GBP\\s*=\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`GBP\\s*1\\s*=\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`Exchange Rate\\s*1\\s*GBP\\s*=\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`Today[’']s rate:\\s*1(?:\\.00)?\\s*GBP\\s*=\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`rate:?\\s*1\\s*GBP\\s*=\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`([0-9]+(?:\\.[0-9]+)?)\\s*${currency}`, "i"),
  ];

  for (const regex of patterns) {
    const match = cleaned.match(regex);
    if (match) {
      const value = Number(match[1]);
      if (Number.isFinite(value) && value > 0 && value < 100) {
        return value;
      }
    }
  }

  return null;
}

function extractFeeFromText(text, sourceCurrency = "GBP") {
  const cleaned = text.replace(/,/g, "").replace(/\s+/g, " ");

  const patterns = [
    new RegExp(`Transfer fees?:\\s*([0-9.]+)\\s*${sourceCurrency}`, "i"),
    new RegExp(`Fees?:\\s*([0-9.]+)\\s*${sourceCurrency}`, "i"),
    new RegExp(`Zero`, "i"),
    new RegExp(`No transfer fees`, "i"),
  ];

  for (const regex of patterns) {
    const match = cleaned.match(regex);
    if (!match) continue;
    if (/Zero/i.test(match[0]) || /No transfer fees/i.test(match[0])) return 0;
    if (match[1]) return Number(match[1]);
  }

  return 0;
}

function extractAmountReceivedFromText(text, currency) {
  const cleaned = text.replace(/,/g, "").replace(/\s+/g, " ");

  const patterns = [
    new RegExp(`Recipient gets\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`They get\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`You receive\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`You get\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`Receive amount\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`([0-9.]+)\\s*${currency}`, "i"),
  ];

  for (const regex of patterns) {
    const match = cleaned.match(regex);
    if (match && match[1]) return Number(match[1]);
  }

  return null;
}

function buildPayloadFromText(source, bodyText) {
  const currency = currencyForDestination(source.destination);
  const sendAmount = Number(source.send_amount || 1);

  let rate = extractRateFromText(bodyText, currency);
  const fee = extractFeeFromText(bodyText, "GBP");
  let amountReceived = extractAmountReceivedFromText(bodyText, currency);

  if (!rate && amountReceived && sendAmount > 0) {
    rate = Number((amountReceived / sendAmount).toFixed(6));
  }

  if (!amountReceived && rate) {
    amountReceived = Number((rate * sendAmount).toFixed(3));
  }

  if (!rate || !amountReceived) return null;

  return {
    provider_name: source.provider,
    origin_country: source.origin,
    destination_country: source.destination,
    payout_method: source.payout_method,
    send_amount: sendAmount,
    exchange_rate: rate,
    fee,
    amount_received: Number(amountReceived.toFixed(3)),
    delivery_speed: null,
    source_type: "browser_automation",
    verification_status: "verified_from_quote_page",
    source_url: source.url,
    checked_at: new Date().toISOString(),
  };
}

function buildResult(source, rate, fee = 0, amountReceived = null, extra = {}) {
  const sendAmount = Number(source.send_amount || 1);
  const normalizedAmountReceived =
    amountReceived !== null && amountReceived !== undefined
      ? Number(Number(amountReceived).toFixed(6))
      : Number(Number(rate).toFixed(6));

  return {
    provider_name: source.provider,
    origin_country: source.origin,
    destination_country: source.destination,
    payout_method: source.payout_method,
    send_amount: sendAmount,
    exchange_rate: Number(Number(rate).toFixed(6)),
    fee: Number(Number(fee || 0).toFixed(6)),
    amount_received: normalizedAmountReceived,
    delivery_speed: null,
    source_type: "browser_automation",
    verification_status: "verified_from_quote_page",
    source_url: source.url,
    checked_at: new Date().toISOString(),
    ...extra,
  };
}

async function collectPageText(page) {
  const bodyText = await page
    .locator("body")
    .innerText()
    .catch(() => "");

  const elementData = await page
    .locator("input, output, span, p, div, label")
    .evaluateAll((elements) =>
      elements
        .map((element) => {
          const text = element.textContent || "";
          const value =
            element instanceof HTMLInputElement
              ? element.value
              : "";

          const ariaLabel =
            element.getAttribute("aria-label") || "";

          return `${text} ${value} ${ariaLabel}`;
        })
        .join("\n")
    )
    .catch(() => "");

  return `${bodyText}\n${elementData}`;
}

function extractGbpGhsRate(text) {
  const cleaned = String(text)
    .replace(/,/g, "")
    .replace(/\s+/g, " ");

  const patterns = [
    /Exchange\s*rate\s*1(?:\.00)?\s*GBP\s*[=≈]\s*([0-9.]+)\s*GHS/i,
    /Rate\s*1(?:\.00)?\s*GBP\s*[=≈]\s*([0-9.]+)\s*GHS/i,
    /1(?:\.00)?\s*GBP\s*[=≈]\s*([0-9.]+)\s*GHS/i,
    /GBP\s*[=≈]\s*([0-9.]+)\s*GHS/i,
    /GBP\s*\/\s*GHS\s*([0-9.]+)/i,
  ];

  for (const pattern of patterns) {
    const match = cleaned.match(pattern);

    if (!match) continue;

    const candidate = parseLocaleNumber(match[1]);

    if (candidate && candidate >= 10 && candidate <= 25) {
      return Number(candidate.toFixed(6));
    }
  }

  /*
   * Some websites display:
   * 100 GBP = 1,520 GHS
   */
  const hundredMatch = cleaned.match(
    /100(?:\.00)?\s*GBP\s*[=≈]\s*([0-9.]+)\s*GHS/i
  );

  if (hundredMatch) {
    const total = parseLocaleNumber(hundredMatch[1]);

    if (total) {
      const rate = total / 100;

      if (rate >= 10 && rate <= 25) {
        return Number(rate.toFixed(6));
      }
    }
  }

  return null;
}

async function handleLemFi(page, source) {
  await page.goto("https://lemfi.com/en-gb/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(4000);

  await page.getByRole("button", { name: /Accept all cookies/i }).click({ timeout: 5000 }).catch(() => {});
  await page.getByRole("button", { name: /Accept all/i }).click({ timeout: 5000 }).catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(1500);

  await page.locator("div").filter({ hasText: /^GBP$/ }).first().click({ force: true }).catch(async () => {
    await page.locator("div").filter({ hasText: /^[A-Z]{3}$/ }).first().click({ force: true });
  });

  let searchInput = page.getByPlaceholder("Enter currency or country").last();
  await searchInput.waitFor({ timeout: 10000 });
  await searchInput.fill("gbp");
  await page.waitForTimeout(1000);
  await page.getByText("United Kingdom", { exact: true }).click().catch(async () => {
    await page.getByText(/United Kingdom/i).first().click();
  });

  await page.waitForTimeout(1500);

  await page.locator("div").filter({ hasText: /^EUR$/ }).first().click({ force: true }).catch(async () => {
    const selectors = page.locator("div").filter({ hasText: /^[A-Z]{3}$/ });
    const count = await selectors.count();
    if (count >= 2) {
      await selectors.nth(1).click({ force: true });
    } else {
      await selectors.first().click({ force: true });
    }
  });

  searchInput = page.getByPlaceholder("Enter currency or country").last();
  await searchInput.waitFor({ timeout: 10000 });
  await searchInput.fill("ghan");
  await page.waitForTimeout(1000);

  await page.getByText("GHS - Ghanian Cedis").click().catch(async () => {
    await page.getByText(/GHS/i).first().click();
  });

  await page.waitForTimeout(1500);

  const sendBox = page.getByRole("textbox", { name: /You send/i });
  await sendBox.waitFor({ timeout: 10000 });
  await sendBox.click({ force: true });
  await sendBox.press("Control+A").catch(() => {});
  await sendBox.fill("1");

  await page.waitForTimeout(5000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  const payload = buildPayloadFromText(source, bodyText);
  if (!payload) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract LemFi rate. Screenshot: ${file}`);
  }

  return payload;
}

async function handleOhentPay(page, source) {
  await page.goto("https://www.ohentpay.com/en-GB", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page
    .getByRole("button", { name: /Accept/i })
    .click({ timeout: 4000 })
    .catch(() => {});

  await page
    .getByRole("link", { name: /See rates/i })
    .click({ timeout: 20000 });

  await page.waitForTimeout(2500);

  const currencySelectors = [
    page.getByRole("combobox").filter({ hasText: /USD/i }).first(),
    page.getByRole("combobox").first(),
    page.locator('[role="combobox"]').first(),
  ];

  let currencyOpened = false;

  for (const selector of currencySelectors) {
    try {
      if (await selector.isVisible({ timeout: 3000 })) {
        await selector.click({
          timeout: 5000,
          force: true,
        });

        currencyOpened = true;
        break;
      }
    } catch (_) {}
  }

  if (!currencyOpened) {
    const file = await saveScreenshot(page, source.provider);

    throw new Error(
      `Ohent Pay currency selector could not be opened. Screenshot: ${file}`
    );
  }

  await page
    .getByText(/Ghanaian cedi\s*\(GHS\)/i)
    .first()
    .click({
      timeout: 15000,
      force: true,
    });

  await page.waitForTimeout(5000);

  let rateText = "";

  const rateParagraph = page
    .getByRole("paragraph")
    .filter({
      hasText: /Exchange rate/i,
    })
    .first();

  if (await rateParagraph.count()) {
    rateText = await rateParagraph
      .innerText()
      .catch(() => "");
  }

  if (!rateText) {
    rateText = await page
      .getByText(/Exchange rate/i)
      .first()
      .textContent()
      .catch(() => "");
  }

  const pageText = await collectPageText(page);
  const combinedText = `${rateText}\n${pageText}`;

  saveDebugText(source.provider, combinedText);

  let rate = extractGbpGhsRate(combinedText);

  /*
   * Ohent Pay may display a sentence resembling:
   * "Exchange rate 100 GBP = 15.20..."
   *
   * In that case, 15.20 is already likely the unit rate rather
   * than the amount received for £100. Accept it only when it is
   * within the realistic GBP/GHS range.
   */
  if (!rate) {
    const ohentMatch = combinedText.match(
      /Exchange\s*rate[^0-9]*100\s*GBP[^0-9]*([0-9]+(?:\.[0-9]+)?)/i
    );

    if (ohentMatch) {
      const candidate = parseLocaleNumber(
        ohentMatch[1]
      );

      if (
        candidate &&
        candidate >= 10 &&
        candidate <= 25
      ) {
        rate = Number(candidate.toFixed(6));
      } else if (
        candidate &&
        candidate >= 1000 &&
        candidate <= 2500
      ) {
        rate = Number(
          (candidate / 100).toFixed(6)
        );
      }
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);

    throw new Error(
      `Could not extract Ohent Pay rate. ` +
      `Captured text: ${combinedText
        .replace(/\s+/g, " ")
        .slice(0, 300)}. ` +
      `Screenshot: ${file}`
    );
  }

  return buildResult(source, rate, 0, rate, {
    verified_method: "ohent_rate_text",
  });
}

async function handlePadiePay(page, source) {
  await page.goto("https://www.padiepay.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(4000);

  await page
    .getByRole("button", { name: "Maybe, later" })
    .click({ timeout: 8000 })
    .catch(() => {});

  await page
    .getByRole("button", { name: "🇺🇸 USD" })
    .click({ timeout: 15000 });

  await page
    .getByText("British Pound Sterling", { exact: true })
    .click({ timeout: 15000 });

  await page.waitForTimeout(1000);

  await page
    .getByRole("button", { name: "🇳🇬 NGN" })
    .click({ timeout: 15000 });

  await page
    .getByText("Ghanaian Cedi", { exact: true })
    .click({ timeout: 15000 });

  await page.waitForTimeout(4000);

  const rateText = await page
    .getByText(/GBP\s*=\s*[0-9.]+\s*GHS/i)
    .first()
    .innerText()
    .catch(() => "");

  const bodyText = `${rateText}\n${await page.locator("body").innerText()}`;

  saveDebugText(source.provider, bodyText);

  const match = bodyText.match(
    /GBP\s*=\s*([0-9.]+)\s*GHS/i
  );

  const rate = match ? parseLocaleNumber(match[1]) : null;

  if (!rate || rate < 10 || rate > 25) {
    const file = await saveScreenshot(page, source.provider);

    throw new Error(
      `Could not extract PadiePay rate. Screenshot: ${file}`
    );
  }

  return buildResult(source, rate, 0, rate);
}

async function handleSendBuddie(page, source) {
  await page.goto("https://www.sendbuddie.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(6000);

  await page
    .getByRole("button", { name: /Accept/i })
    .click({ timeout: 4000 })
    .catch(() => {});

  await page.keyboard.press("Escape").catch(() => {});

  const comboboxes = page.getByRole("combobox");

  const comboboxCount = await comboboxes.count();

  if (comboboxCount < 2) {
    const file = await saveScreenshot(page, source.provider);

    throw new Error(
      `SendBuddie currency selectors were not found. Screenshot: ${file}`
    );
  }

  // Sending currency
  await comboboxes
    .first()
    .click({
      timeout: 15000,
      force: true,
    });

  await page
    .getByRole("option", { name: /GBP\s+GBP/i })
    .first()
    .click({
      timeout: 15000,
      force: true,
    })
    .catch(async () => {
      await page
        .getByText(/GBP\s+GBP/i)
        .first()
        .click({
          timeout: 10000,
          force: true,
        });
    });

  await page.waitForTimeout(1500);

  // Receiving currency
  await comboboxes
    .nth(1)
    .click({
      timeout: 15000,
      force: true,
    });

  await page
    .getByRole("option", { name: /GH\s+GHS/i })
    .first()
    .click({
      timeout: 15000,
      force: true,
    })
    .catch(async () => {
      await page
        .getByText(/GH\s+GHS/i)
        .first()
        .click({
          timeout: 10000,
          force: true,
        });
    });

  await page.waitForTimeout(2500);

  /*
   * Use a realistic send amount because some calculators do
   * not update reliably for £1.
   */
  const scrapeAmount = 100;

  const sendInputCandidates = [
    page.getByRole("textbox", {
      name: /You send/i,
    }),

    page.locator(
      'input[placeholder*="Amount" i]'
    ).first(),

    page.locator("input:visible").first(),
  ];

  let sendInput = null;

  for (const candidate of sendInputCandidates) {
    try {
      if (
        await candidate.isVisible({
          timeout: 3000,
        })
      ) {
        sendInput = candidate;
        break;
      }
    } catch (_) {}
  }

  if (sendInput) {
    await sendInput.click({ force: true });

    await sendInput
      .press("Control+A")
      .catch(() => {});

    await sendInput.fill(
      String(scrapeAmount)
    );

    await sendInput.press("Tab").catch(() => {});
  }

  await page.waitForTimeout(6000);

  /*
   * Do not click the displayed exchange rate.
   * Read the page and form values directly.
   */
  const pageText = await collectPageText(page);

  saveDebugText(source.provider, pageText);

  let rate = extractGbpGhsRate(pageText);
  let quotedAmountReceived = null;

  /*
   * If the rate is rendered only inside the recipient input,
   * calculate the unit rate from the quote.
   */
  if (!rate) {
    const recipientInputCandidates = [
      page.getByRole("textbox", {
        name: /Recipient gets/i,
      }),

      page.locator(
        'input[aria-label*="Recipient gets" i]'
      ),

      page.locator("input:visible").nth(1),
    ];

    for (const candidate of recipientInputCandidates) {
      try {
        if (
          await candidate.isVisible({
            timeout: 2500,
          })
        ) {
          const rawValue = await candidate
            .inputValue()
            .catch(() => "");

          const parsedValue =
            parseLocaleNumber(rawValue);

          if (
            parsedValue &&
            parsedValue > 0
          ) {
            quotedAmountReceived = parsedValue;
            break;
          }
        }
      } catch (_) {}
    }

    if (
      quotedAmountReceived &&
      scrapeAmount > 0
    ) {
      const calculatedRate =
        quotedAmountReceived / scrapeAmount;

      if (
        calculatedRate >= 10 &&
        calculatedRate <= 25
      ) {
        rate = Number(
          calculatedRate.toFixed(6)
        );
      }
    }
  }

  /*
   * Additional extraction for text such as:
   * "Recipient gets 1,520.00 GHS"
   */
  if (!rate) {
    const recipientMatch = pageText.match(
      /Recipient\s*gets[^0-9]*([0-9,.]+)\s*GHS/i
    );

    if (recipientMatch) {
      quotedAmountReceived =
        parseLocaleNumber(recipientMatch[1]);

      if (
        quotedAmountReceived &&
        scrapeAmount > 0
      ) {
        const calculatedRate =
          quotedAmountReceived / scrapeAmount;

        if (
          calculatedRate >= 10 &&
          calculatedRate <= 25
        ) {
          rate = Number(
            calculatedRate.toFixed(6)
          );
        }
      }
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);

    throw new Error(
      `Could not extract SendBuddie rate. ` +
      `Captured text: ${pageText
        .replace(/\s+/g, " ")
        .slice(0, 400)}. ` +
      `Screenshot: ${file}`
    );
  }

  return buildResult(source, rate, 0, rate, {
    quoted_send_amount: scrapeAmount,
    quoted_amount_received:
      quotedAmountReceived,
    verified_method:
      quotedAmountReceived
        ? "sendbuddie_recipient_amount_calculation"
        : "sendbuddie_visible_rate_text",
  });
}

async function handleTransferGalaxy(page, source) {
  await page.goto(
    "https://transfergalaxy.com/en/destination/ghana/",
    {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    }
  );

  await page.waitForTimeout(5000);

  await page
    .locator("#languageModal a")
    .filter({ hasText: "English" })
    .click({ timeout: 8000 })
    .catch(() => {});

  await page
    .getByRole("button", { name: /Allow all/i })
    .click({ timeout: 5000 })
    .catch(() => {});

  await page
    .getByRole("combobox", { name: "Sweden" })
    .click({ timeout: 15000 });

  await page
    .locator("#bs-select-1-3")
    .click({ timeout: 15000 });

  await page.waitForTimeout(1000);

  await page
    .getByRole("combobox", { name: "Pick a country" })
    .click({ timeout: 15000 });

  const search = page.getByRole("combobox", {
    name: "Search",
  });

  await search.fill("GH");

  await page.waitForTimeout(800);

  await page
    .locator("#bs-select-2-30")
    .click({ timeout: 15000 });

  await page.waitForTimeout(4000);

  const widgetText = await page
    .locator("#aocResponse")
    .innerText()
    .catch(() => "");

  const bodyText = `${widgetText}\n${await page.locator("body").innerText()}`;

  saveDebugText(source.provider, bodyText);

  const match = bodyText.match(
    /GBP\s*=\s*([0-9.]+)\s*GHS/i
  );

  const rate = match ? parseLocaleNumber(match[1]) : null;

  if (!rate || rate < 10 || rate > 25) {
    const file = await saveScreenshot(page, source.provider);

    throw new Error(
      `Could not extract TransferGalaxy rate. Screenshot: ${file}`
    );
  }

  return buildResult(source, rate, 0, rate);
}

async function handleVeloRemit(page, source) {
  const response = await page.goto("https://veloremit.com/en", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  const status = response?.status() || null;

  const initialText = await page
    .locator("body")
    .innerText()
    .catch(() => "");

  const blocked =
    status === 403 ||
    /403\s*ERROR/i.test(initialText) ||
    /request could not be satisfied/i.test(initialText) ||
    /request blocked/i.test(initialText) ||
    /cloudfront/i.test(initialText);

  if (blocked) {
    const file = await saveScreenshot(
      page,
      source.provider
    );

    throw new Error(
      `VeloRemit rejected the browser request with HTTP ${status}. ` +
      `Run this provider in headed mode or remove it from automated collection. ` +
      `Screenshot: ${file}`
    );
  }

  await page
    .getByRole("button", {
      name: "Currency Converter",
    })
    .click({
      timeout: 15000,
    });

  await page.waitForTimeout(1000);

  await page
    .getByText("GBP", {
      exact: true,
    })
    .click({
      timeout: 15000,
    });

  await page
    .locator("div")
    .filter({
      hasText: /^United Kingdom - GBP$/,
    })
    .first()
    .click({
      timeout: 15000,
    });

  await page.waitForTimeout(1000);

  await page
    .getByText("GHS", {
      exact: true,
    })
    .click({
      timeout: 15000,
    });

  await page
    .locator("div")
    .filter({
      hasText: /^Ghana - GHS$/,
    })
    .first()
    .click({
      timeout: 15000,
    });

  await page.waitForTimeout(1500);

  /*
   * Do not depend on the generated Mantine ID because it changes
   * between sessions.
   */
  const amountInputCandidates = [
    page.getByRole("textbox").first(),

    page.locator(
      'input[type="number"]:visible'
    ).first(),

    page.locator(
      'input:visible'
    ).first(),
  ];

  let amountInput = null;

  for (const candidate of amountInputCandidates) {
    try {
      if (
        await candidate.isVisible({
          timeout: 3000,
        })
      ) {
        amountInput = candidate;
        break;
      }
    } catch (_) {}
  }

  if (!amountInput) {
    const file = await saveScreenshot(
      page,
      source.provider
    );

    throw new Error(
      `VeloRemit amount field was not found. Screenshot: ${file}`
    );
  }

  await amountInput.click({
    force: true,
  });

  await amountInput
    .press("Control+A")
    .catch(() => {});

  await amountInput.fill("100");

  await amountInput
    .press("Tab")
    .catch(() => {});

  await page.waitForTimeout(5000);

  /*
   * Read the displayed rate instead of clicking it.
   */
  const rateLocator = page
    .getByText(
      /(?:Rate\s*)?1\s*GBP\s*≈\s*[0-9.]+\s*GHS/i
    )
    .first();

  const directRateText = await rateLocator
    .innerText()
    .catch(() => "");

  const bodyText = await page
    .locator("body")
    .innerText()
    .catch(() => "");

  const combinedText =
    `${directRateText}\n${bodyText}`;

  saveDebugText(
    source.provider,
    combinedText
  );

  const patterns = [
    /Rate\s*1\s*GBP\s*≈\s*([0-9.]+)\s*GHS/i,

    /1\s*GBP\s*≈\s*([0-9.]+)\s*GHS/i,

    /GBP\s*≈\s*([0-9.]+)\s*GHS/i,
  ];

  let rate = null;

  for (const pattern of patterns) {
    const match = combinedText.match(pattern);

    if (!match) continue;

    const candidate = parseLocaleNumber(
      match[1]
    );

    if (
      candidate &&
      candidate >= 10 &&
      candidate <= 25
    ) {
      rate = Number(
        candidate.toFixed(6)
      );

      break;
    }
  }

  if (!rate) {
    const file = await saveScreenshot(
      page,
      source.provider
    );

    throw new Error(
      `Could not extract VeloRemit rate. ` +
      `Captured text: ${combinedText
        .replace(/\s+/g, " ")
        .slice(0, 300)}. ` +
      `Screenshot: ${file}`
    );
  }

  return buildResult(
    source,
    rate,
    0,
    rate,
    {
      quoted_send_amount: 100,
      verified_method:
        "veloremit_visible_rate_text",
    }
  );
}

async function handleCurrencyFlow(page, source) {
  await page.goto("https://www.currencyflow.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(4000);

  await page
    .getByLabel("To currency")
    .selectOption("GHS");

  await page.waitForTimeout(4000);

  const rateText = await page
    .getByText(/GBP\s*=\s*[0-9.]+\s*GHS/i)
    .first()
    .innerText()
    .catch(() => "");

  const bodyText = `${rateText}\n${await page.locator("body").innerText()}`;

  saveDebugText(source.provider, bodyText);

  const match = bodyText.match(
    /GBP\s*=\s*([0-9.]+)\s*GHS/i
  );

  const rate = match ? parseLocaleNumber(match[1]) : null;

  if (!rate || rate < 10 || rate > 25) {
    const file = await saveScreenshot(page, source.provider);

    throw new Error(
      `Could not extract CurrencyFlow rate. Screenshot: ${file}`
    );
  }

  return buildResult(source, rate, 0, rate);
}

async function runSource(browser, source) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1200 },
  });

  try {
    let payload;

    if (source.provider === "LemFi") payload = await handleLemFi(page, source);
    else if (source.provider === "Sendwave") payload = await handleSendwave(page, source);
    else if (source.provider === "TapTap Send") payload = await handleTapTap(page, source);
    else if (source.provider === "TransferGo") payload = await handleTransferGo(page, source);
    else if (source.provider === "PayAngel") payload = await handlePayAngel(page, source);
    else if (source.provider === "RemitChoice") payload = await handleRemitChoice(page, source);
    else if (source.provider === "RizRemit") payload = await handleRizRemit(page, source);
    else if (source.provider === "Nala") payload = await handleNala(page, source);
    else if (source.provider === "Roze Remit") payload = await handleRozeRemit(page, source);
    else if (source.provider === "UnityLink") payload = await handleUnityLink(page, source);
    else if (source.provider === "Afripay") payload = await handleAfripay(page, source);
    else if (source.provider === "Continental Money") payload = await handleContinentalMoney(page, source);
    else if (source.provider === "FP Transfer") payload = await handleFPTransfer(page, source);
    else if (source.provider === "Instarem") payload = await handleInstarem(page, source);
    else if (source.provider === "JubaExpress") payload = await handleJubaExpress(page, source);
    else if (source.provider === "Jupay") payload = await handleJupay(page, source);
    else if (source.provider === "OaPay") payload = await handleOaPay(page, source);
    else if (source.provider === "Ohent Pay") payload = await handleOhentPay(page, source);
    else if (source.provider === "PadiePay") payload = await handlePadiePay(page, source);
    else if (source.provider === "Paysend") payload = await handlePaysend(page, source);
    else if (source.provider === "RemitnGo") payload = await handleRemitnGo(page, source);
    else if (source.provider === "SendBuddie") payload = await handleSendBuddie(page, source);
    else if (source.provider === "TransferGalaxy") payload = await handleTransferGalaxy(page, source);
    else if (source.provider === "VeloRemit") payload = await handleVeloRemit(page, source);
    else if (source.provider === "Mukuru") payload = await handleMukuru(page, source);
    else if (source.provider === "XE") payload = await handleXE(page, source);
    else if (source.provider === "PandaRemit") payload = await handlePandaRemit(page, source);
    else if (source.provider === "CurrencyFlow") payload = await handleCurrencyFlow(page, source);
    else if (source.provider === "Xoom") payload = await handleXoom(page, source);
    else if (source.provider === "Paymit") payload = await handlePaymit(page, source);
    else if (source.provider === "Pesa.co") payload = await handlePesaCo(page, source);
    else throw new Error(`No handler configured for ${source.provider}`);
    await postQuote(payload);
    console.log(`OK: ${source.provider} ${source.origin}->${source.destination}`);
  } finally {
    await page.close();
  }
}

async function main() {
  const sources = JSON.parse(fs.readFileSync("./sources.json", "utf8"));
  const browser = await chromium.launch({ headless: HEADLESS });

  for (const source of sources) {
    try {
      await runSource(browser, source);
    } catch (err) {
      console.error(`FAIL: ${source.provider} - ${err.message}`);
    }
  }

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});