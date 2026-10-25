import { setTimeout as sleep } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { Browser, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as navigationGuard from "../navigation-guard.js";
import { getPlaywrightCore } from "../playwright-core.runtime.js";
import { atBarrier, runRoute } from "./agent-route.test-support.js";
import { createExistingSessionAgentSharedModule } from "./existing-session.test-support.js";
import { createBrowserRouteApp } from "./test-helpers.js";

const browserState = vi.hoisted(() => ({ page: undefined as Page | undefined }));
vi.mock("../chrome-mcp.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../chrome-mcp.js")>()),
  withChromeMcpDocument: async (
    _params: unknown,
    task: (document: { evaluate: (fn: string) => Promise<unknown> }) => Promise<unknown>,
  ) => {
    const page = expectDefined(browserState.page, "Chromium page is not initialized");
    return await task({ evaluate: (fn) => page.evaluate(`(${fn})(document)`) });
  },
}));
vi.mock("./agent.shared.js", () => createExistingSessionAgentSharedModule());

const { registerBrowserAgentActRoutes } = await import("./agent.act.js");
const button = (attributes = "") => `<button id="target" ${attributes}>Ready</button>`;
const contents = (children = "") => `<div id="target" style="display:contents">${children}</div>`;
const markPredicate = '() => { document.title = "predicate ran"; return true; }';

describe.runIf(process.env.OPENCLAW_BROWSER_WAIT_E2E === "1")(
  "existing-session selector wait visibility in Chromium",
  () => {
    let browser: Browser;
    let page: Page;
    beforeAll(async () => {
      browser = await getPlaywrightCore().chromium.launch({
        headless: true,
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      });
      page = await browser.newPage();
      browserState.page = page;
    });
    afterAll(async () => {
      browserState.page = undefined;
      await browser?.close();
    });

    async function waitForSelector(selector: string, extra: Record<string, unknown> = {}) {
      const { app, postHandlers } = createBrowserRouteApp();
      registerBrowserAgentActRoutes(app, {
        state: () => ({ resolved: { evaluateEnabled: true } }),
      } as never);
      return runRoute(postHandlers.get("/act"), {
        body: { kind: "wait", selector, timeoutMs: 250, ...extra },
      });
    }

    it.each([
      ["display:none", button('style="display:none"'), false],
      ["visibility:hidden", button('style="visibility:hidden"'), false],
      ["hidden attribute", button("hidden"), false],
      ["zero width", '<div id="target" style="width:0;height:10px"></div>', false],
      ["zero height", '<div id="target" style="width:10px;height:0"></div>', false],
      ["empty display:contents", contents(), false],
      ["closed details", `<details><summary>Open</summary>${button()}</details>`, false],
      ["missing element", "<p>No target</p>", false],
      ["ordinary element", button(), true],
      ["opacity zero", button('style="opacity:0"'), true],
      ["offscreen element", button('style="position:absolute;left:-10000px"'), true],
      ["display:contents element child", contents("<button>Ready</button>"), true],
      ["display:contents text child", contents("Ready"), true],
    ] as const)("checks %s visibility", async (_name, html, visible) => {
      await page.setContent(html);
      const pending = waitForSelector("#target");
      if (visible) {
        expect((await pending).statusCode).toBe(200);
      } else {
        await expect(pending).rejects.toThrow("Timed out waiting for condition");
      }
    });

    it("waits for the first match to become visible rather than accepting another match", async () => {
      await page.setContent(
        '<button class="target" hidden>First</button><button class="target">Second</button>',
      );
      let settled = false;
      const pending = waitForSelector(".target", { timeoutMs: 2_000 }).then((response) => {
        settled = true;
        return response;
      });
      try {
        await sleep(400);
        expect(settled).toBe(false);
        await page
          .locator(".target")
          .first()
          .evaluate((element) => element.removeAttribute("hidden"));
        expect((await pending).statusCode).toBe(200);
      } finally {
        await pending;
      }
    });

    it("preserves invalid-selector errors", async () => {
      await expect(waitForSelector("[")).rejects.toThrow("not a valid selector");
    });

    it("preserves combined-condition short-circuiting and async function waits", async () => {
      await page.setContent(button());
      await expect(
        waitForSelector("#target", {
          text: "Not ready",
          fn: '() => { document.title = "should not run"; return true; }',
        }),
      ).rejects.toThrow("Timed out waiting for condition");
      expect(await page.title()).not.toBe("should not run");
      const ready = await waitForSelector("#target", {
        text: "Ready",
        textGone: "Not ready",
        loadState: "load",
        fn: "async () => { await Promise.resolve(); return true; }",
      });
      expect(ready.statusCode).toBe(200);
    });

    it("readmits a changed URL before running the predicate after an awaited policy check", async () => {
      await page.goto("about:blank#before");
      await page.setContent(button());
      const readmissionStarted = createDeferred<void>();
      const readmissionAllowed = createDeferred<void>();
      const observedUrls: string[] = [];
      const policy = vi
        .spyOn(navigationGuard, "assertBrowserNavigationResultAllowed")
        .mockImplementation(async ({ url }) => {
          observedUrls.push(url);
          if (url === "about:blank#before") {
            await page.evaluate(() => history.replaceState(null, "", "#after"));
          } else {
            readmissionStarted.resolve();
            await readmissionAllowed.promise;
          }
        });
      const pending = waitForSelector("#target", { timeoutMs: 2_000, fn: markPredicate });
      try {
        await atBarrier(
          readmissionStarted.promise,
          pending,
          "Wait completed before URL readmission",
        );
        expect(await page.title()).toBe("");
        readmissionAllowed.resolve();
        expect((await pending).statusCode).toBe(200);
        expect(observedUrls).toEqual(["about:blank#before", "about:blank#after"]);
        expect(await page.title()).toBe("predicate ran");
      } finally {
        readmissionAllowed.resolve();
        await pending.catch(() => {});
        policy.mockRestore();
        await page.goto("about:blank");
      }
    });

    it("ignores page-controlled globalThis when admitting the document URL", async () => {
      await page.goto("about:blank");
      await page.setContent(button());
      await page.evaluate(() => {
        Object.defineProperty(window, "globalThis", {
          value: { document, location: { href: "https://spoof.example" } },
          configurable: true,
          writable: true,
        });
      });
      const observedUrls: string[] = [];
      const policy = vi
        .spyOn(navigationGuard, "assertBrowserNavigationResultAllowed")
        .mockImplementation(async ({ url }) => {
          observedUrls.push(url);
          if (url === "about:blank") {
            throw new Error("Actual document URL denied");
          }
        });
      try {
        await expect(waitForSelector("#target", { fn: markPredicate })).rejects.toThrow(
          "Actual document URL denied",
        );
        expect(observedUrls).toEqual(["about:blank"]);
        expect(await page.title()).toBe("");
      } finally {
        policy.mockRestore();
        await page.goto("about:blank");
      }
    });
  },
);
