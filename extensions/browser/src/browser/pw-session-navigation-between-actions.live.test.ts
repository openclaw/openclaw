import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { SsrFPolicy } from "openclaw/plugin-sdk/security-runtime";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listenOnLoopback } from "../../../test-support/hanging-loopback-server.js";
import { isLiveTestEnabled } from "../../test-support.js";
import { BROWSER_ACTION_NAVIGATION_GRACE_MS } from "./act-policy.js";
import { readTargetId } from "./pw-chromium.test-support.js";
import { closePlaywrightBrowserConnection } from "./pw-session.js";
import { pressKeyViaPlaywright } from "./pw-tools-core.interactions.actions.js";

// The source is an allowed IP literal; `localhost` reaches the same loopback
// fixture but is denied by this policy, so a request there proves a bypass.
const strictSsrfPolicy: SsrFPolicy = {
  dangerouslyAllowPrivateNetwork: false,
  allowedHostnames: ["127.0.0.1"],
};
const strictPolicy = { ssrfPolicy: strictSsrfPolicy, standingSsrfPolicy: strictSsrfPolicy };
const delayMs = BROWSER_ACTION_NAVIGATION_GRACE_MS * 2;

describe.skipIf(!isLiveTestEnabled())(
  "document policy between browser actions (real Chromium)",
  () => {
    let context: BrowserContext;
    let rootDir: string;
    let cdpUrl: string;
    let sourceUrl: string;
    let deniedOrigin: string;
    let deniedUrl: string;
    let deniedRequests = 0;
    // Both fixtures serve the same page: a key press makes it navigate to `next` later.
    const serve = (req: IncomingMessage, res: ServerResponse) => {
      const next = new URL(req.url ?? "/", sourceUrl).searchParams.get("next") ?? "";
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" }).end(
        `<!doctype html><title>Fixture</title><script>
          addEventListener("keydown", () => setTimeout(() => { location.href = ${JSON.stringify(next)}; }, ${delayMs}));
        </script>`,
      );
    };
    const source = createServer(serve);
    const denied = createServer((req, res) => {
      deniedRequests += 1;
      serve(req, res);
    });

    beforeAll(async () => {
      rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-between-actions-live-"));
      sourceUrl = `http://127.0.0.1:${await listenOnLoopback(source)}`;
      deniedOrigin = `http://localhost:${await listenOnLoopback(denied)}`;
      deniedUrl = `${deniedOrigin}/document`;
      const profileDir = path.join(rootDir, "chromium-profile");
      context = await chromium.launchPersistentContext(profileDir, {
        headless: true,
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
        args: ["--remote-debugging-port=0", "--no-proxy-server"],
      });
      const port = (await fs.readFile(path.join(profileDir, "DevToolsActivePort"), "utf8")).split(
        "\n",
      )[0];
      cdpUrl = `http://127.0.0.1:${port}`;
    }, 30_000);

    afterAll(async () => {
      await closePlaywrightBrowserConnection({ cdpUrl });
      await context?.close();
      for (const server of [source, denied]) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      }
      await fs.rm(rootDir, { recursive: true, force: true });
    });

    async function open(origin: string, next: string): Promise<{ page: Page; targetId: string }> {
      const page = await context.newPage();
      await page.goto(`${origin}/?next=${encodeURIComponent(next)}`);
      return { page, targetId: await readTargetId(page) };
    }
    const openSource = (next: string) => open(sourceUrl, next);
    // The loopback exception: private hosts allowed for this invocation only.
    const grantedPolicy = {
      ssrfPolicy: { ...strictSsrfPolicy, allowedHostnames: ["127.0.0.1", "localhost"] },
      standingSsrfPolicy: strictSsrfPolicy,
      assertNavigationCurrent: () => {},
    };

    it("blocks a denied document the page requests after the action's grace window", async () => {
      const { page, targetId } = await openSource(deniedUrl);
      const startUrl = page.url();
      deniedRequests = 0;
      try {
        await pressKeyViaPlaywright({ cdpUrl, targetId, key: "a", ...strictPolicy });
        await sleep(delayMs * 3);
        expect({ deniedRequests, url: page.url() }).toEqual({ deniedRequests: 0, url: startUrl });
      } finally {
        await page.close();
      }
    }, 20_000);

    it("ends an invocation's grant with the invocation", async () => {
      const { page, targetId } = await openSource(deniedUrl);
      const startUrl = page.url();
      deniedRequests = 0;
      try {
        await pressKeyViaPlaywright({ cdpUrl, targetId, key: "a", ...grantedPolicy });
        await sleep(delayMs * 3);
        expect({ deniedRequests, url: page.url() }).toEqual({ deniedRequests: 0, url: startUrl });
      } finally {
        await page.close();
      }
    }, 20_000);

    it("lets a page keep loading documents from the origin its tab is already on", async () => {
      // A dev page opened under the exception reloads and follows its own links later.
      const { page, targetId } = await open(deniedOrigin, "/?arrived=1");
      try {
        await pressKeyViaPlaywright({ cdpUrl, targetId, key: "a", ...grantedPolicy });
        await page.waitForURL(`${deniedOrigin}/?arrived=1`, { timeout: 5_000 });
      } finally {
        await page.close();
      }
    }, 20_000);

    it("shows the browser's blocked page for a denied navigation the page did not request", async () => {
      const { page, targetId } = await openSource("#");
      deniedRequests = 0;
      const session = await context.newCDPSession(page);
      try {
        await pressKeyViaPlaywright({ cdpUrl, targetId, key: "Shift", ...strictPolicy });
        // Browser-initiated, as the address bar is: no page request and no referrer.
        await session.send("Page.navigate", { url: deniedUrl });
        await expect
          .poll(() => page.url(), { timeout: 5_000 })
          .toBe("chrome-error://chromewebdata/");
        // Reloading the blocked page asks for the denied address again.
        await session.send("Page.reload");
        await sleep(delayMs);
        expect(deniedRequests).toBe(0);
        // The blocked page is not a denied document: the tab stays usable.
        await pressKeyViaPlaywright({ cdpUrl, targetId, key: "Shift", ...strictPolicy });
      } finally {
        await page.close();
      }
    }, 20_000);

    it("lets the page load an allowed document between actions", async () => {
      const { page, targetId } = await openSource("/?arrived=1");
      try {
        await pressKeyViaPlaywright({ cdpUrl, targetId, key: "a", ...strictPolicy });
        await page.waitForURL(`${sourceUrl}/?arrived=1`, { timeout: 5_000 });
      } finally {
        await page.close();
      }
    }, 20_000);
  },
);
