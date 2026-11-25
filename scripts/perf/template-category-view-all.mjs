// BENCH_URL=<isolated Control UI> node scripts/perf/template-category-view-all.mjs
// BENCH_CONTROL_URL adds an interleaved comparison against an isolated unchanged UI.
// No keys, saved browser profile, or production Gateway are needed.
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const {
  BENCH_URL,
  BENCH_CONTROL_URL = BENCH_URL,
  BENCH_CATEGORIES = "travel,productivity,research,engineering,operations",
  BENCH_LOADS = "3",
} = process.env;
assert(BENCH_URL, "Set BENCH_URL to an isolated Control UI with Templates enabled");
const categories = BENCH_CATEGORIES.split(",");
const loads = Number(BENCH_LOADS);
assert(Number.isSafeInteger(loads) && loads > 0);
assert(categories.every((slug) => /^[a-z][a-z-]*$/.test(slug)));
const browser = await chromium.launch();
const viewport = { width: 1440, height: 1000 };
const section = (slug) => `[data-catalog-section="${slug}"]`;

// A chip makes an independent canonical category read, outside the measured run. Validate
// the first rendered cards (including order), even when View all sends no category RPC.
async function readReferences() {
  const page = await browser.newPage({ viewport });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  const pending = new Map();
  const references = new Map();
  cdp.on("Network.webSocketFrameSent", ({ response }) => {
    if (response.opcode !== 1 || !response.payloadData.startsWith("{")) {
      return;
    }
    const msg = JSON.parse(response.payloadData);
    if (
      msg.method === "templates.catalog.search" &&
      msg.params?.category &&
      !msg.params.limit &&
      !msg.params.query
    ) {
      pending.set(msg.id, msg.params.category);
    }
  });
  cdp.on("Network.webSocketFrameReceived", ({ response }) => {
    if (response.opcode !== 1 || !response.payloadData.startsWith("{")) {
      return;
    }
    const msg = JSON.parse(response.payloadData);
    if (pending.has(msg.id) && msg.ok && Array.isArray(msg.payload?.entries)) {
      references.set(
        pending.get(msg.id),
        msg.payload.entries.map((entry) => [entry.displayName, "@" + entry.ownerHandle]),
      );
      pending.delete(msg.id);
    }
  });
  await page.goto(new URL("/templates", BENCH_CONTROL_URL).href);
  const chips = page.locator("[data-templates-explore] button");
  for (const slug of categories) {
    await chips.filter({ hasText: new RegExp("^" + slug + "$", "i") }).click();
    await page
      .locator(section(slug) + " [data-templates-results] [data-templates-entry]")
      .first()
      .waitFor();
    assert(
      references.get(slug)?.length,
      "Reference chip must produce a complete category RPC: " + slug,
    );
  }
  await page.close();
  return references;
}

try {
  const expected = await readReferences();
  const page = await browser.newPage({ viewport });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  let categoryRequests = 0;
  cdp.on("Network.webSocketFrameSent", ({ response }) => {
    if (response.opcode === 1 && response.payloadData.startsWith("{")) {
      const msg = JSON.parse(response.payloadData);
      if (msg.method === "templates.catalog.search" && msg.params?.category) {
        categoryRequests++;
      }
    }
  });
  await page.addInitScript(() => {
    const observer = new MutationObserver(() => {
      if (document.querySelector("[data-templates-category] [data-templates-entry]")) {
        observer.disconnect();
        requestAnimationFrame(() =>
          requestAnimationFrame(() => performance.mark("bench-shelves-painted")),
        );
      }
    });
    observer.observe(document, { childList: true, subtree: true });
  });
  for (let load = 1; load <= loads; load++) {
    const arms =
      BENCH_CONTROL_URL === BENCH_URL
        ? [["candidate", BENCH_URL]]
        : [
            ["control", BENCH_CONTROL_URL],
            ["candidate", BENCH_URL],
          ];
    for (const [arm, url] of load % 2 ? arms : arms.toReversed()) {
      for (const category of categories) {
        const selector = section(category);
        const button = page.locator(selector + " .plugin-catalog-section__view-all");
        await cdp.send("Network.clearBrowserCache");
        categoryRequests = 0;
        await page.goto(new URL("/templates", url).href, { waitUntil: "domcontentloaded" });
        await button.waitFor({ timeout: 60_000 });
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(500);
        const shelfRequests = categoryRequests;
        const result = await button.evaluate(
          (element, root) =>
            new Promise((resolve, reject) => {
              const initialPaint =
                performance.getEntriesByName("bench-shelves-painted")[0]?.startTime;
              const timer = setTimeout(() => {
                observer.disconnect();
                reject(new Error("No category results"));
              }, 30_000);
              const observer = new MutationObserver(() => {
                const cards = [
                  ...document.querySelectorAll(
                    root + " [data-templates-results] [data-templates-entry]",
                  ),
                ];
                if (!cards.length) {
                  return;
                }
                observer.disconnect();
                const identities = cards.map((card) => [
                  card.querySelector("h3")?.textContent,
                  card.querySelector("h3 + span")?.textContent,
                ]);
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => {
                    clearTimeout(timer);
                    resolve({ initialPaint, paintMs: performance.now() - start, identities });
                  }),
                );
              });
              observer.observe(document.body, { childList: true, subtree: true });
              const start = performance.now();
              element.click();
            }),
          selector,
        );
        assert(result.initialPaint > 0, "Overview cards must actually paint");
        assert.deepEqual(
          result.identities,
          expected.get(category),
          "First paint must match the independent full category list",
        );
        console.log(
          JSON.stringify({
            arm,
            load,
            category,
            count: result.identities.length,
            paintMs: result.paintMs,
            overviewPaintMs: result.initialPaint,
            shelfRequests,
            clickRequests: categoryRequests - shelfRequests,
          }),
        );
      }
    }
  }
} finally {
  await browser.close();
}
