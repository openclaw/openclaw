# Rendered-Page Extraction Patterns

Use browser extraction only when the data is hidden behind rendering, client-side interactions, pagination, or downloads. If a plain HTTP fetch or documented API can answer the question, use that first.

## Basic Extraction

```typescript
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto("https://example.com/products");
await page.waitForSelector(".product-card");

const products = await page.$$eval(".product-card", (cards) =>
  cards.map((card) => ({
    name: card.querySelector(".name")?.textContent?.trim(),
    price: card.querySelector(".price")?.textContent?.trim(),
    url: card.querySelector("a")?.href,
  })),
);

await browser.close();
```

## Wait Strategies for Dynamic Apps

```typescript
await page.waitForSelector('[data-loaded="true"]');
await page.waitForSelector(".loading-spinner", { state: "hidden" });

await expect
  .poll(async () => {
    return await page.locator(".product").count();
  })
  .toBeGreaterThan(0);
```

Use `networkidle` only when the app genuinely becomes quiet. Polling, analytics, and sockets often make it the wrong condition.

## Infinite Scroll

```typescript
async function scrollToBottom(page: Page) {
  let previousHeight = 0;
  let previousCount = 0;

  while (true) {
    const currentHeight = await page.evaluate(() => document.body.scrollHeight);
    if (currentHeight === previousHeight) break;

    previousHeight = currentHeight;
    previousCount = await page.locator(".product-card").count();
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect
      .poll(async () => {
        return await page.locator(".product-card").count();
      })
      .toBeGreaterThan(previousCount);
  }
}
```

## Pagination

```typescript
async function scrapeAllPages(page: Page) {
  const allData = [];

  while (true) {
    allData.push(...(await extractData(page)));

    const nextButton = page.getByRole("button", { name: "Next" });
    if (!(await nextButton.isVisible()) || (await nextButton.isDisabled())) break;

    await nextButton.click();
    await page.locator(".results").waitFor();
  }

  return allData;
}
```

## Retries and Error Handling

```typescript
async function scrapeWithRetry(url: string, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const page = await context.newPage();
    try {
      await page.goto(url, { timeout: 30000 });
      return await extractData(page);
    } catch (error) {
      if (attempt === retries) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    } finally {
      await page.close();
    }
  }
}
```

## Respectful Throttling

```typescript
class RateLimiter {
  private lastRequest = 0;

  constructor(private minDelay: number) {}

  async wait() {
    const elapsed = Date.now() - this.lastRequest;
    if (elapsed < this.minDelay) {
      await new Promise((resolve) => setTimeout(resolve, this.minDelay - elapsed));
    }
    this.lastRequest = Date.now();
  }
}
```

Throttle multi-page work, respect robots and terms where applicable, and keep scope aligned with the user's request.

## Structured Data Extraction

```typescript
const jsonLd = await page.$eval('script[type="application/ld+json"]', (el) =>
  JSON.parse(el.textContent || "{}"),
);

const tableData = await page.$$eval("table tbody tr", (rows) =>
  rows.map((row) => Array.from(row.querySelectorAll("td")).map((td) => td.textContent?.trim())),
);
```

When extracting repeated items, prefer locating the correct collection first and only then evaluating over that collection. Do not scrape the whole page if the user only needs one bounded region.

## Avoid by Default

- Browser-fingerprint hacks, rotating exits, or challenge-solving services.
- Blind session persistence across tasks.
- Extraction plans that ignore cheaper API or HTTP paths.
- Wide crawls when the user only asked for one page, one result set, or one bounded workflow.
