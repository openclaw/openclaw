// BENCH_URL=<isolated Control UI> node scripts/perf/template-category-view-all.mjs
// Cold browser cache, a fresh /templates navigation per click. No user session or data is reused.
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const { BENCH_URL, BENCH_CATEGORIES = "travel,productivity,research,engineering,operations" } =
  process.env;
assert(BENCH_URL, "Set BENCH_URL to an isolated Control UI with Templates enabled");
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  let requestId;
  let expectedCount;
  cdp.on("Network.webSocketFrameSent", ({ response }) => {
    if (response.opcode !== 1 || !response.payloadData.startsWith("{")) {
      return;
    }
    const message = JSON.parse(response.payloadData);
    if (message.method === "templates.catalog.search" && message.params?.category) {
      requestId = message.id;
    }
  });
  cdp.on("Network.webSocketFrameReceived", ({ response }) => {
    if (!requestId || response.opcode !== 1 || !response.payloadData.startsWith("{")) {
      return;
    }
    const message = JSON.parse(response.payloadData);
    if (message.id === requestId) {
      expectedCount = message.payload?.entries?.length;
    }
  });
  for (let load = 1; load <= 3; load++) {
    for (const category of BENCH_CATEGORIES.split(",")) {
      assert(/^[a-z][a-z-]*$/.test(category), "Expected a category slug");
      const section = `[data-catalog-section="${category}"]`;
      const button = page.locator(section + " .plugin-catalog-section__view-all");
      await cdp.send("Network.clearBrowserCache");
      await page.goto(new URL("/templates", BENCH_URL).href, { waitUntil: "domcontentloaded" });
      await button.waitFor({ timeout: 60_000 });
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(500);
      requestId = undefined;
      expectedCount = undefined;
      const result = await button.evaluate(
        (element, selector) =>
          new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              observer.disconnect();
              reject(new Error("No category results"));
            }, 30_000);
            const observer = new MutationObserver(() => {
              const count = document.querySelectorAll(
                selector + " [data-templates-results] [data-templates-entry]",
              ).length;
              if (!count) {
                return;
              }
              observer.disconnect();
              requestAnimationFrame(() =>
                requestAnimationFrame(() => {
                  clearTimeout(timer);
                  resolve({ paintMs: performance.now() - start, count });
                }),
              );
            });
            observer.observe(document.body, { childList: true, subtree: true });
            const start = performance.now();
            element.click();
          }),
        section,
      );
      assert.equal(
        result.count,
        expectedCount,
        "First paint must contain the full category response",
      );
      console.log(JSON.stringify({ load, category, ...result }));
    }
  }
} finally {
  await browser.close();
}
