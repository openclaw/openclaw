import path from "node:path";
import type {
  BrowserAnnotationApi,
  BrowserAnnotationState,
} from "openclaw/plugin-sdk/browser-annotations";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test-support.js";
import { resolveBrowserConfig } from "./config.js";
import { getPlaywrightCore } from "./playwright-core.runtime.js";
import { closePlaywrightBrowserConnection } from "./pw-session.js";
import { createBrowserRouteDispatcher } from "./routes/dispatcher.js";
import { createBrowserRouteContext, type BrowserServerState } from "./server-context.js";
import { getFreePort } from "./test-port.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe.runIf(process.env.OPENCLAW_BROWSER_ANNOTATIONS_E2E === "1")(
  "native page annotations through Chromium browser routes",
  () => {
    it("selects and previews a non-Codex surface, reloads the SDK, and rejects stale authority", async () => {
      const port = await getFreePort();
      const cdpUrl = `http://127.0.0.1:${port}`;
      const browser = await getPlaywrightCore().chromium.launchPersistentContext(
        path.join(tempDirs.make("openclaw-browser-annotations-"), "profile"),
        {
          headless: true,
          executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
          args: [`--remote-debugging-port=${port}`],
        },
      );
      try {
        const page = browser.pages()[0] ?? (await browser.newPage());
        await page.route("http://127.0.0.1:11111/**", (route) =>
          route.fulfill({
            contentType: "text/html",
            body: `<!doctype html><button id="enter">Annotate</button>
              <canvas width="160" height="144" style="display:block;margin:20px;background:#123456"></canvas>`,
          }),
        );
        await page.goto("http://127.0.0.1:11111/native-fixture");
        const session = await browser.newCDPSession(page);
        const { targetInfo } = await session.send("Target.getTargetInfo");
        await session.detach();
        const state: BrowserServerState = {
          port: 0,
          resolved: resolveBrowserConfig({
            defaultProfile: "annotations",
            evaluateEnabled: true,
            ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
            profiles: { annotations: { cdpUrl, color: "#123456", attachOnly: true } },
          }),
          profiles: new Map(),
        };
        const dispatcher = createBrowserRouteDispatcher(
          createBrowserRouteContext({ getState: () => state }),
        );
        let current = true;
        const call = (command: Record<string, unknown>) =>
          dispatcher.dispatch({
            method: "POST",
            path: "/annotations",
            body: { targetId: targetInfo.targetId, ...command },
            assertCurrent: () => {
              if (!current) {
                throw new Error("Session access revoked");
              }
            },
          });
        const initial = await call({ action: "state" });
        expect(initial.status, JSON.stringify(initial.body)).toBe(200);
        const documentId = (initial.body as BrowserAnnotationState).documentId;
        await page.evaluate(() => {
          const api = (
            document as Document & { openclaw: { annotation: BrowserAnnotationApi<Element> } }
          ).openclaw.annotation;
          const canvas = document.querySelector("canvas")!;
          const controls = api.registerControls({
            targets: canvas,
            controlsHeading: "Native plugin color",
            controls: [{ type: "color", callback: "color", currentValue: "#123456" }],
          });
          api.registerSurface({
            element: canvas,
            hitTest() {
              const rect = canvas.getBoundingClientRect();
              return {
                id: "native-square",
                name: "Native square",
                rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                metadata: { plugin: "native-fixture" },
              };
            },
            renderSelection() {},
          });
          canvas.addEventListener("openclawannotationcontrolchange", (event) => {
            const value = (event as CustomEvent<{ value: string }>).detail.value;
            canvas.style.background = value;
            controls.update({
              controls: [{ type: "color", callback: "color", currentValue: value }],
            });
          });
          document.getElementById("enter")!.addEventListener("click", () => api.toggle(true));
        });
        await page.locator("#enter").click();
        const selected = await call({ action: "select", documentId, clientX: 50, clientY: 80 });
        expect(selected.status, JSON.stringify(selected.body)).toBe(200);
        expect(selected.body).toMatchObject({
          active: true,
          selection: { id: "native-square", metadata: { plugin: "native-fixture" } },
        });
        const selection = (selected.body as BrowserAnnotationState).selection!;
        const changed = await call({
          action: "control",
          documentId,
          change: "preview",
          callback: "color",
          value: "#fedcba",
          virtualTarget: { surfaceId: selection.surfaceId, targetId: selection.id },
        });
        expect(changed.status, JSON.stringify(changed.body)).toBe(200);
        expect((changed.body as BrowserAnnotationState).controls[0]?.currentValue).toBe("#fedcba");
        expect(
          await page
            .locator("canvas")
            .evaluate((canvas) => getComputedStyle(canvas).backgroundColor),
        ).toBe("rgb(254, 220, 186)");
        await page.reload();
        expect(
          await page.evaluate(
            () =>
              typeof (
                document as Document & { openclaw?: { annotation?: BrowserAnnotationApi<Element> } }
              ).openclaw?.annotation,
          ),
        ).toBe("object");
        const stale = await call({ action: "stop", documentId });
        expect(stale.status).toBeGreaterThanOrEqual(400);
        expect((await call({ action: "state" })).body).toMatchObject({
          active: false,
          selection: null,
          surfaceCount: 0,
        });
        current = false;
        expect((await call({ action: "state" })).status).toBeGreaterThanOrEqual(400);
      } finally {
        await closePlaywrightBrowserConnection({ cdpUrl });
        await browser.close();
      }
    });
  },
);
