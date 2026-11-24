import { once } from "node:events";
import { createServer } from "node:http";
import { SsrFBlockedError } from "openclaw/plugin-sdk/security-runtime";
import { acquireTestPortBlock } from "openclaw/plugin-sdk/test-env";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { isLiveTestEnabled } from "../../test-support.js";
import * as navigationGuard from "./navigation-guard.js";
import {
  gotoPageWithNavigationGuard,
  wasBrowserNavigationSourcePreservedAfterPolicyDenial,
  withPageNavigationRequestGuard,
} from "./pw-session-navigation.js";

describe.skipIf(!isLiveTestEnabled())(
  "document guard tolerates page-cancelled interceptions (real Chromium)",
  () => {
    let browser: Browser;
    let ports: Awaited<ReturnType<typeof acquireTestPortBlock>>;
    let sourceUrl: string;
    let deniedUrl: string;
    const server = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      if (req.url === "/source") {
        // The page removes its frame while the frame's document request is
        // paused for policy, so Chromium retires that interception id.
        res.end(
          '<title>Source</title><iframe id="frame" src="/child"></iframe><script>' +
            "window.cancelFrame = () => document.getElementById('frame').remove();</script>",
        );
        return;
      }
      res.end("<title>Child</title>");
    });

    /** Hold each policy check until Chromium reports the paused document cancelled. */
    const holdPolicyUntilCancelled = (page: Page, path: string) => {
      const cancelled = new Promise<void>((resolve) => {
        page.on("requestfailed", (request) => {
          if (new URL(request.url()).pathname === path) {
            resolve();
          }
        });
      });
      const check = navigationGuard.assertBrowserNavigationAllowed;
      vi.spyOn(navigationGuard, "assertBrowserNavigationAllowed").mockImplementation(
        async (options) => {
          if (new URL(options.url).pathname === path) {
            void page.evaluate(() => (window as { cancelFrame?: () => void }).cancelFrame?.());
            await cancelled;
          }
          return await check(options);
        },
      );
      return cancelled;
    };

    beforeAll(async () => {
      ports = await acquireTestPortBlock({ offsets: [0] });
      sourceUrl = "http://127.0.0.1:" + ports.port;
      deniedUrl = "http://127.0.0.2:" + ports.port;
      server.listen(ports.port, "0.0.0.0");
      await once(server, "listening");
      browser = await chromium.launch({
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
        args: ["--no-proxy-server", "--site-per-process"],
      });
    }, 30_000);
    afterEach(() => {
      vi.restoreAllMocks();
    });
    afterAll(async () => {
      await browser?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await ports?.release();
    });

    const policy = { ssrfPolicy: { allowedHostnames: ["127.0.0.1"] } };

    it("completes a guarded goto when the page cancels a paused child document", async () => {
      const page = await browser.newPage();
      try {
        const cancelled = holdPolicyUntilCancelled(page, "/child");
        const response = await gotoPageWithNavigationGuard({
          cdpUrl: sourceUrl,
          page,
          url: sourceUrl + "/source",
          timeoutMs: 10_000,
          ...policy,
        });
        await cancelled;
        expect(response?.status()).toBe(200);
        expect(await page.title()).toBe("Source");
      } finally {
        await page.close();
      }
    });

    it("completes a guarded action when the page cancels a paused child document", async () => {
      const page = await browser.newPage();
      try {
        await page.goto(sourceUrl + "/source");
        await withPageNavigationRequestGuard({
          page,
          ...policy,
          action: async () => {
            const cancelled = holdPolicyUntilCancelled(page, "/late-child");
            await page.evaluate(() => {
              document.getElementById("frame")?.setAttribute("src", "/late-child");
            });
            await cancelled;
          },
        });
        expect(await page.title()).toBe("Source");
      } finally {
        await page.close();
      }
    });

    it("still reports a denied document the page cancelled while paused", async () => {
      const page = await browser.newPage();
      try {
        await page.goto(sourceUrl + "/source");
        const error = await withPageNavigationRequestGuard({
          page,
          ...policy,
          action: async () => {
            const cancelled = holdPolicyUntilCancelled(page, "/denied-child");
            await page.evaluate((url) => {
              document.getElementById("frame")?.setAttribute("src", url);
            }, deniedUrl + "/denied-child");
            await cancelled;
          },
        }).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(SsrFBlockedError);
        expect(wasBrowserNavigationSourcePreservedAfterPolicyDenial(error)).toBe(true);
        expect(page.url()).toBe(sourceUrl + "/source");
      } finally {
        await page.close();
      }
    });
  },
);
