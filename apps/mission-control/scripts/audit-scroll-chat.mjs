#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";

const baseUrl = process.env.MC_AUDIT_BASE_URL || "http://127.0.0.1:3001";
const outputDir = path.resolve(process.cwd(), "output/playwright");

const scenarios = [
  {
    id: "board-desktop",
    path: "/?workspace=golden#board",
    viewport: { width: 1536, height: 960 },
    scrollRootTestId: "mc-view-scroll-root",
    expectBottomReachable: true,
  },
  {
    id: "chat-desktop",
    path: "/?workspace=golden#chat",
    viewport: { width: 1536, height: 960 },
    scrollRootTestId: "mc-chat-scroll-root",
    expectBottomReachable: true,
    expectComposerVisible: true,
  },
  {
    id: "agents-desktop",
    path: "/?workspace=golden#agents",
    viewport: { width: 1536, height: 960 },
    scrollRootTestId: "mc-view-scroll-root",
    expectBottomReachable: false,
  },
  {
    id: "board-mobile",
    path: "/?workspace=golden#board",
    viewport: { width: 390, height: 844 },
    scrollRootTestId: "mc-view-scroll-root",
    expectBottomReachable: true,
  },
  {
    id: "chat-mobile",
    path: "/?workspace=golden#chat",
    viewport: { width: 390, height: 844 },
    scrollRootTestId: "mc-chat-scroll-root",
    expectBottomReachable: true,
    expectComposerVisible: true,
  },
  {
    id: "agents-mobile",
    path: "/?workspace=golden#agents",
    viewport: { width: 390, height: 844 },
    scrollRootTestId: "mc-view-scroll-root",
    expectBottomReachable: false,
  },
];

/**
 * @typedef {{
 *   id: string;
 *   url: string;
 *   viewport: { width: number; height: number };
 *   docScrollable: boolean;
 *   bodyScrollable: boolean;
 *   headerTopBefore: number | null;
 *   headerTopAfter: number | null;
 *   scrollRootFound: boolean;
 *   scrollRootOverflowY: string | null;
 *   scrollRootScrollable: boolean;
 *   scrollRootClientHeight: number;
 *   scrollRootScrollHeight: number;
 *   scrollRootTop: number | null;
 *   scrollRootBottom: number | null;
 *   bottomReachable: boolean | null;
 *   composerPresent: boolean;
 *   composerVisible: boolean | null;
 *   jumpToLatestVisible: boolean;
 * }} ScenarioResult
 */

/**
 * @param {ScenarioResult} result
 * @param {{
 *   expectBottomReachable: boolean;
 *   expectComposerVisible?: boolean;
 *   scrollRootTestId: string;
 * }} scenario
 */
function evaluateScenario(result, scenario) {
  const failures = [];

  if (result.docScrollable) {
    failures.push("document became vertically scrollable");
  }
  if (result.bodyScrollable) {
    failures.push("body became vertically scrollable");
  }
  if (result.headerTopBefore !== 0 || result.headerTopAfter !== 0) {
    failures.push(
      `header not pinned (before=${result.headerTopBefore}, after=${result.headerTopAfter})`
    );
  }
  if (!result.scrollRootFound) {
    failures.push(`missing scroll root [data-testid='${scenario.scrollRootTestId}']`);
  }
  if (result.scrollRootFound && !["auto", "scroll", "overlay", "hidden"].includes(result.scrollRootOverflowY || "")) {
    failures.push(`unexpected scroll root overflow-y '${result.scrollRootOverflowY}'`);
  }
  if (
    scenario.expectBottomReachable &&
    result.scrollRootScrollable &&
    result.bottomReachable !== true
  ) {
    failures.push("could not reach bottom of active scroll container");
  }
  if (result.scrollRootFound && (result.scrollRootTop !== null || result.scrollRootBottom !== null)) {
    if ((result.scrollRootTop ?? 0) < 0 || (result.scrollRootBottom ?? 0) > result.viewport.height) {
      failures.push("scroll root moved outside viewport bounds");
    }
  }
  if (scenario.expectComposerVisible && result.composerPresent && !result.composerVisible) {
    failures.push("chat composer was not visible in viewport");
  }

  return failures;
}

await fs.mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

const consoleErrorsByScenario = new Map();
let activeScenarioId = "";
page.on("console", (message) => {
  if (message.type() !== "error") {return;}
  const errors = consoleErrorsByScenario.get(activeScenarioId) || [];
  errors.push(message.text());
  consoleErrorsByScenario.set(activeScenarioId, errors);
});

/** @type {ScenarioResult[]} */
const results = [];
const failures = [];

try {
  for (const scenario of scenarios) {
    activeScenarioId = scenario.id;
    const url = new URL(scenario.path, baseUrl).toString();

    await page.setViewportSize(scenario.viewport);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    await page
      .waitForSelector(`[data-testid="${scenario.scrollRootTestId}"]`, {
        state: "attached",
        timeout: 5000,
      })
      .catch(() => {});
    await page.waitForFunction(
      () => document.styleSheets.length > 0,
      { timeout: 3000 }
    ).catch(() => {});
    await page.waitForTimeout(200);

    /** @type {ScenarioResult} */
    const metrics = await page.evaluate(({ scrollRootTestId }) => {
      const target = document.querySelector(`[data-testid="${scrollRootTestId}"]`);

      const header = document.querySelector("header");
      const headerTopBefore = header ? Math.round(header.getBoundingClientRect().top) : null;

      let bottomReachable = null;
      let scrollRootOverflowY = null;
      let scrollRootScrollable = false;
      let scrollRootClientHeight = 0;
      let scrollRootScrollHeight = 0;
      let scrollRootTop = null;
      let scrollRootBottom = null;

      if (target && target.scrollHeight > target.clientHeight + 4) {
        const styles = getComputedStyle(target);
        scrollRootOverflowY = styles.overflowY;
        scrollRootScrollable = true;
        scrollRootClientHeight = target.clientHeight;
        scrollRootScrollHeight = target.scrollHeight;
        const targetRect = target.getBoundingClientRect();
        scrollRootTop = Math.round(targetRect.top);
        scrollRootBottom = Math.round(targetRect.bottom);

        const previous = target.scrollTop;
        target.scrollTop = target.scrollHeight;
        bottomReachable = target.scrollTop + target.clientHeight >= target.scrollHeight - 2;
        target.scrollTop = previous;
      } else if (target) {
        const styles = getComputedStyle(target);
        scrollRootOverflowY = styles.overflowY;
        scrollRootClientHeight = target.clientHeight;
        scrollRootScrollHeight = target.scrollHeight;
        const targetRect = target.getBoundingClientRect();
        scrollRootTop = Math.round(targetRect.top);
        scrollRootBottom = Math.round(targetRect.bottom);
      }

      const headerTopAfter = header ? Math.round(header.getBoundingClientRect().top) : null;

      const composer = document.querySelector(
        'textarea, input[placeholder*="Type a message"], [contenteditable="true"]'
      );
      let composerVisible = null;
      if (composer) {
        const rect = composer.getBoundingClientRect();
        composerVisible = rect.top >= 0 && rect.bottom <= window.innerHeight;
      }

      const jumpToLatestVisible = [...document.querySelectorAll("button")].some((button) =>
        /jump to latest/i.test(button.textContent || "")
      );

      return {
        id: "",
        url: location.href,
        viewport: { width: innerWidth, height: innerHeight },
        docScrollable:
          document.documentElement.scrollHeight >
          document.documentElement.clientHeight + 2,
        bodyScrollable: document.body.scrollHeight > document.body.clientHeight + 2,
        headerTopBefore,
        headerTopAfter,
        scrollRootFound: Boolean(target),
        scrollRootOverflowY,
        scrollRootScrollable,
        scrollRootClientHeight,
        scrollRootScrollHeight,
        scrollRootTop,
        scrollRootBottom,
        bottomReachable,
        composerPresent: Boolean(composer),
        composerVisible,
        jumpToLatestVisible,
      };
    }, { scrollRootTestId: scenario.scrollRootTestId });

    metrics.id = scenario.id;
    results.push(metrics);

    await page.screenshot({
      path: path.join(outputDir, `audit-${scenario.id}.png`),
      fullPage: true,
    });

    const scenarioFailures = evaluateScenario(metrics, scenario);
    if (scenarioFailures.length > 0) {
      failures.push(
        `${scenario.id}: ${scenarioFailures.join("; ")}`
      );
    }

    const consoleErrors = consoleErrorsByScenario.get(scenario.id) || [];
    const hydrationErrors = consoleErrors.filter((line) =>
      line.toLowerCase().includes("hydration failed")
    );
    if (hydrationErrors.length > 0) {
      failures.push(`${scenario.id}: hydration mismatch detected`);
    }
  }
} finally {
  activeScenarioId = "";
  await browser.close();
}

const resultPath = path.join(outputDir, "audit-scroll-chat-results.json");
await fs.writeFile(resultPath, `${JSON.stringify(results, null, 2)}\n`, "utf8");

if (failures.length > 0) {
  console.error("Scroll/chat audit failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  console.error(`Detailed metrics: ${resultPath}`);
  process.exit(1);
}

console.log("Scroll/chat audit passed.");
console.log(`Detailed metrics: ${resultPath}`);
