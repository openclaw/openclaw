import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test-support.js";
import { resolveBrowserConfig } from "../config.js";
import { getPlaywrightCore } from "../playwright-core.runtime.js";
import { closePlaywrightBrowserConnection } from "../pw-session.js";
import { createBrowserRouteContext, type BrowserServerState } from "../server-context.js";
import { getFreePort } from "../test-port.js";
import { registerBrowserAgentActRoutes } from "./agent.act.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe.runIf(process.env.OPENCLAW_BROWSER_PASTE_E2E === "1")("Chromium focused paste", () => {
  it("inserts at the selection in password, multiline, editable, and cross-origin fields", async () => {
    const port = await getFreePort();
    const cdpUrl = `http://127.0.0.1:${port}`;
    const context = await getPlaywrightCore().chromium.launchPersistentContext(
      path.join(tempDirs.make("openclaw-browser-paste-"), "profile"),
      {
        headless: true,
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
        args: [`--remote-debugging-port=${port}`],
      },
    );
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      await page.route("http://127.0.0.1:11111/**", async (route) => {
        await route.fulfill({
          contentType: "text/html",
          body: `<input id="password" type="password" value="before-old-after">
            <textarea id="multiline">before-old-after</textarea>
            <div id="editable" contenteditable>before-old-after</div>
            <iframe src="http://127.0.0.1:22222/field"></iframe>
            <script>document.addEventListener("input", () => document.body.dataset.input = "yes")</script>`,
        });
      });
      await page.route("http://127.0.0.1:22222/**", async (route) => {
        await route.fulfill({
          contentType: "text/html",
          body: '<input id="frame" type="password" value="before-old-after">',
        });
      });
      await page.goto("http://127.0.0.1:11111/form");
      const session = await context.newCDPSession(page);
      const { targetInfo } = await session.send("Target.getTargetInfo");
      await session.detach();
      const state: BrowserServerState = {
        port: 0,
        resolved: resolveBrowserConfig({
          defaultProfile: "paste",
          evaluateEnabled: false,
          ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
          profiles: { paste: { cdpUrl, color: "#123456", attachOnly: true } },
        }),
        profiles: new Map(),
      };
      const routes = createBrowserRouteApp();
      registerBrowserAgentActRoutes(
        routes.app,
        createBrowserRouteContext({ getState: () => state }),
      );
      const act = expectDefined(routes.postHandlers.get("/act"), "registered act route");
      const paste = async (text: string) => {
        const response = createBrowserRouteResponse();
        await act(
          {
            params: {},
            query: {},
            body: { kind: "insertText", targetId: targetInfo.targetId, text },
          },
          response.res,
        );
        expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
        expect(response.body).toMatchObject({ ok: true, targetId: targetInfo.targetId });
        expect(JSON.stringify(response.body)).not.toContain(text);
      };

      for (const [selector, text] of [
        ["#password", "  p🦞ss  "],
        ["#multiline", "  first 🦞\nsecond  "],
      ] as const) {
        const field = page.locator(selector);
        await field.evaluate((element) => {
          const input = element as HTMLInputElement;
          input.focus();
          input.setSelectionRange(7, 10);
        });
        await paste(text);
        expect(await field.inputValue()).toBe(`before-${text}-after`);
      }
      expect(await page.locator("body").getAttribute("data-input")).toBe("yes");

      const editable = page.locator("#editable");
      await editable.evaluate((element) => {
        (element as HTMLElement).focus();
        const range = document.createRange();
        range.setStart(element.firstChild!, 7);
        range.setEnd(element.firstChild!, 10);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
      });
      await paste("editable 🦞");
      expect(await editable.textContent()).toBe("before-editable 🦞-after");

      const frameField = page.frameLocator("iframe").locator("#frame");
      await frameField.evaluate((element) => {
        const input = element as HTMLInputElement;
        input.focus();
        input.setSelectionRange(7, 10);
      });
      await paste("iframe 🦞");
      expect(await frameField.inputValue()).toBe("before-iframe 🦞-after");
      expect(await page.locator("#password").inputValue()).toBe("before-  p🦞ss  -after");
    } finally {
      await closePlaywrightBrowserConnection({ cdpUrl });
      await context.close();
    }
  }, 30_000);
});
