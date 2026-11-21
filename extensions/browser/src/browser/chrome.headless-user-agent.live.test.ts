import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { acquireTestPortBlock } from "openclaw/plugin-sdk/test-env";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { listenOnLoopback } from "../../../test-support/hanging-loopback-server.js";
import { isLiveTestEnabled } from "../../test-support.js";

const fixture = vi.hoisted(() => ({ root: "" }));
vi.mock("openclaw/plugin-sdk/text-utility-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/text-utility-runtime")>()),
  get CONFIG_DIR() {
    return fixture.root;
  },
}));
vi.mock("./paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./paths.js")>()),
  get DEFAULT_DOWNLOAD_DIR() {
    return path.join(fixture.root, "downloads");
  },
}));

import { launchOpenClawChrome, stopOpenClawChrome, type RunningChrome } from "./chrome.js";
import { resolveBrowserConfig, resolveProfile } from "./config.js";

describe.skipIf(!isLiveTestEnabled())("managed headless user-agent (real Chromium)", () => {
  let claim: Awaited<ReturnType<typeof acquireTestPortBlock>>;
  let origin: string;
  let frameOrigin: string;
  let running: RunningChrome | undefined;
  let browser: Browser | undefined;
  let clientHints: Record<string, string | string[] | undefined> = {};
  const received = new Map<string, Array<string | undefined>>();
  const server = createServer((req, res) => {
    const requestPath = req.url ?? "/";
    const userAgents = received.get(requestPath) ?? [];
    userAgents.push(req.headers["user-agent"]);
    received.set(requestPath, userAgents);
    if (requestPath === "/document") {
      clientHints = {
        brands: req.headers["sec-ch-ua"],
        mobile: req.headers["sec-ch-ua-mobile"],
        platform: req.headers["sec-ch-ua-platform"],
      };
    }
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    res.end(
      req.url === "/document"
        ? `<!doctype html><body><iframe src="${frameOrigin}/frame"></iframe><a id="popup" href="/popup" target="_blank">Open</a></body>`
        : "<!doctype html><body>ready</body>",
    );
  });

  beforeAll(async () => {
    fixture.root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-headless-ua-live-"));
    claim = await acquireTestPortBlock({ offsets: [0] });
    const port = await listenOnLoopback(server);
    origin = `http://127.0.0.1:${port}`;
    frameOrigin = `http://localhost:${port}`;
  });

  afterAll(async () => {
    await browser?.close();
    if (running) {
      await stopOpenClawChrome(running);
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await claim?.release();
    if (fixture.root) {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("sets the first request and JavaScript identity for tabs, popups, frames and restarts", async () => {
    let nativeUserAgent = "";
    for (const mode of ["native", "chrome", "chrome", "custom"] as const) {
      received.clear();
      const resolved = resolveBrowserConfig({
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
        headless: true,
        headlessUserAgent: mode === "native" ? "native" : "chrome",
        extraArgs: mode === "custom" ? ["--user-agent=OpenClaw-UA-Fixture/1.0"] : [],
        profiles: { openclaw: { cdpPort: claim.port, color: "#FF4500" } },
      });
      const profile = resolveProfile(resolved, "openclaw")!;
      running = await launchOpenClawChrome(resolved, profile);
      browser = await chromium.connectOverCDP(profile.cdpUrl);
      const context = browser.contexts()[0];
      if (!context) {
        throw new Error("Managed Chrome did not expose its default context.");
      }
      const page = await context.newPage();
      await page.goto(`${origin}/document`);
      await page.frameLocator("iframe").locator("body").waitFor();
      const actualUserAgent = await page.evaluate(() => navigator.userAgent);
      if (mode === "native") {
        expect(actualUserAgent).toContain("HeadlessChrome/");
        nativeUserAgent = actualUserAgent;
      }
      const expectedUserAgent =
        mode === "native"
          ? nativeUserAgent
          : mode === "custom"
            ? "OpenClaw-UA-Fixture/1.0"
            : nativeUserAgent.replace("HeadlessChrome/", "Chrome/");
      const popupReady = page.waitForEvent("popup");
      await page.locator("#popup").click();
      const popup = await popupReady;
      await popup.waitForLoadState("domcontentloaded");
      const second = await context.newPage();
      await second.goto(`${origin}/second`);
      for (const requestPath of ["/document", "/frame", "/popup", "/second"]) {
        expect(received.get(requestPath), `${mode}: ${requestPath}`).toEqual([expectedUserAgent]);
      }
      for (const frame of [...page.frames(), popup.mainFrame(), second.mainFrame()]) {
        expect(await frame.evaluate(() => navigator.userAgent)).toBe(expectedUserAgent);
      }
      expect(running.headlessUserAgent).toBe(mode === "chrome" ? "chrome" : "native");
      console.info("User-agent Client Hints", JSON.stringify({ mode, ...clientHints }));
      await browser.close();
      browser = undefined;
      await stopOpenClawChrome(running);
      running = undefined;
    }
  }, 60_000);
});
