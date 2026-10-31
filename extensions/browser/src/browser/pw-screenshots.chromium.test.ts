import fs from "node:fs/promises";
import { getImageMetadata } from "openclaw/plugin-sdk/media-runtime";
import type { Page } from "playwright-core";
import { afterEach, expect, it as test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test-support.js";
import { captureScreenshot } from "./cdp.js";
import { resolveBrowserConfig } from "./config.js";
import { withChromiumPage, type ChromiumTarget } from "./pw-chromium.test-support.js";
import { getPageForTargetId } from "./pw-session.js";
import { BROWSER_REF_MARKER_ATTRIBUTE } from "./pw-session.page-cdp.js";
import { clickViaPlaywright } from "./pw-tools-core.interactions.actions.js";
import {
  screenshotWithLabelsViaPlaywright,
  takeScreenshotViaPlaywright,
} from "./pw-tools-core.interactions.content.js";
import {
  resizeViewportViaPlaywright,
  snapshotRoleViaPlaywright,
} from "./pw-tools-core.snapshot.js";
import { setDeviceViaPlaywright } from "./pw-tools-core.state.js";
import { registerBrowserAgentSnapshotRoutes } from "./routes/agent.snapshot.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./routes/test-helpers.js";
import type { AnnotationItem } from "./screenshot-annotate.js";
import { createBrowserRouteContext, type BrowserServerState } from "./server-context.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const it = test.runIf(process.env.OPENCLAW_BROWSER_SNAPSHOT_E2E === "1");
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>*{box-sizing:border-box}html,body{margin:0}section{height:600px;border:8px solid #23d7b3;background:#102a43;position:relative}
section+section{background:#334e68}button{position:absolute;left:25px;top:430px;width:120px;height:60px;border:0;background:#e04f5f}</style>
<section><button aria-label="Target"></button></section><section></section>`;
const readGeometry = () => ({
  width: innerWidth,
  height: innerHeight,
  dpr: devicePixelRatio,
  scrollX,
  scrollY,
  screen: [screen.width, screen.height, screen.orientation.type],
  touch: navigator.maxTouchPoints,
  visual: {
    x: visualViewport!.pageLeft,
    y: visualViewport!.pageTop,
    width: visualViewport!.width,
    height: visualViewport!.height,
  },
});

type PixelSample = [x: number, y: number, rgb: number[]];

function snapshotRoutes({ cdpUrl, targetId }: ChromiumTarget) {
  const state: BrowserServerState = {
    port: 0,
    resolved: resolveBrowserConfig({
      defaultProfile: "capture",
      profiles: { capture: { cdpUrl, color: "#123456", attachOnly: true } },
    }),
    profiles: new Map(),
  };
  const routes = createBrowserRouteApp();
  registerBrowserAgentSnapshotRoutes(
    routes.app,
    createBrowserRouteContext({ getState: () => state }),
  );
  return async (
    route: "/snapshot" | "/screenshot",
    options: Record<string, unknown> = {},
    expectedStatus = 200,
  ) => {
    const response = createBrowserRouteResponse();
    const data = { targetId, ...(route === "/snapshot" ? { format: "ai" } : {}), ...options };
    if (route === "/snapshot") {
      await routes.getHandlers.get(route)!({ params: {}, query: data }, response.res);
    } else {
      await routes.postHandlers.get(route)!({ params: {}, query: {}, body: data }, response.res);
    }
    expect(response.statusCode, JSON.stringify(response.body)).toBe(expectedStatus);
    return response;
  };
}

function withBrowser(
  run: (target: ChromiumTarget, page: Page, wsUrl: string) => Promise<void>,
  deviceScaleFactor?: number,
  showScrollbars = false,
) {
  return withChromiumPage(
    tempDirs.make("openclaw-screenshot-geometry-"),
    html,
    async ({ target, page }) => {
      const tabs = (await fetch(`${target.cdpUrl}/json/list`).then((response) =>
        response.json(),
      )) as Array<{
        id: string;
        webSocketDebuggerUrl: string;
      }>;
      const tab = tabs.find(({ id }) => id === target.targetId)!;
      await run(target, page, tab.webSocketDebuggerUrl);
    },
    {
      ...(showScrollbars ? { ignoreDefaultArgs: ["--hide-scrollbars"] } : {}),
      ...(deviceScaleFactor
        ? { viewport: { width: 640, height: 480 }, deviceScaleFactor }
        : { viewport: null }),
    },
  );
}

async function expectImage(
  page: Page,
  buffer: Buffer,
  size: [number, number],
  points: PixelSample[],
) {
  expect([buffer.readUInt32BE(16), buffer.readUInt32BE(20)]).toEqual(size);
  expect((await inspectImage(page, buffer, points)).pixels).toEqual(
    points.map((point) => point[2]),
  );
}

const frameButton = (page: Page, selector = "iframe", name?: string) =>
  page.frameLocator(selector).getByRole("button", name ? { name } : {});

async function replaceFrame(page: Page, selector: string, name: string, observer = page) {
  await page.locator(selector).evaluate((frame, label) => {
    (frame as HTMLIFrameElement).srcdoc = `<button>${label}</button>`;
  }, name);
  await frameButton(observer, selector, name).waitFor();
}

function setSectionTransform(page: Page, transform: string) {
  return page
    .locator("section")
    .first()
    .evaluate((section, value) => {
      section.style.transform = value;
    }, transform);
}

async function inspectImage(page: Page, buffer: Buffer, points?: PixelSample[]) {
  return await page.evaluate(
    async ({ base64, points: samplePoints }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      if (samplePoints) {
        return {
          pixels: samplePoints.map(([x, y]) =>
            Array.from(context.getImageData(x, y, 1, 1).data).slice(0, 3),
          ),
        };
      }
      const { data } = context.getImageData(0, 0, image.width, image.height);
      let redX = 0,
        redY = 0,
        redCount = 0;
      for (let y = 0; y < image.height; y++) {
        for (let x = 0; x < image.width; x++) {
          const i = (y * image.width + x) * 4;
          if (data[i]! > 170 && data[i + 1]! < 120 && data[i + 2]! < 150) {
            redX += x;
            redY += y;
            redCount++;
          }
        }
      }
      const centerX = Math.round(redX / redCount),
        centerY = Math.round(redY / redCount);
      const yellow = (x: number, y: number) => {
        const i = (y * image.width + x) * 4;
        return data[i]! > 200 && data[i + 1]! > 120 && data[i + 2]! < 100;
      };
      const xs = Array.from({ length: image.width }, (_, x) => x).filter((x) => yellow(x, centerY));
      const ys = Array.from({ length: image.height }, (_, y) => y).filter((y) =>
        yellow(centerX, y),
      );
      return {
        box: {
          x: xs[0]!,
          y: ys[0]!,
          width: xs.at(-1)! - xs[0]! + 1,
          height: ys.at(-1)! - ys[0]! + 1,
        },
      };
    },
    { base64: buffer.toString("base64"), points },
  );
}

it.each(["response", "markers", "sibling"])(
  "preserves captured-frame authority during %s navigation",
  (stage) =>
    withBrowser(async (target, page) => {
      await page.setContent(
        `<iframe id="selected" srcdoc="<button onclick=&quot;this.textContent='Selected clicked'&quot;>Original child</button>"></iframe><iframe id="sibling" srcdoc="<button>Sibling child</button>"></iframe>`,
      );
      await frameButton(page, "#selected").waitFor();
      await frameButton(page, "#sibling").waitFor();
      const capturedPage = await getPageForTargetId(target);
      const capture = capturedPage.ariaSnapshot.bind(capturedPage);
      let captured = false;
      const captureSpy = vi
        .spyOn(capturedPage, "ariaSnapshot")
        .mockImplementation(async (options) => {
          const snapshot = await capture(options);
          captured = true;
          return snapshot;
        });
      const context = capturedPage.context();
      const newSession = context.newCDPSession.bind(context);
      let navigated = false;
      const navigatedSelector = stage === "sibling" ? "#sibling" : "#selected";
      const navigateChild = async () => {
        navigated = true;
        await replaceFrame(page, navigatedSelector, "Replacement child", capturedPage);
      };
      const sessionSpy = vi
        .spyOn(context, "newCDPSession")
        .mockImplementation(async (pageOrFrame) => {
          const cdp = await newSession(pageOrFrame);
          const send = cdp.send.bind(cdp);
          vi.spyOn(cdp, "send").mockImplementation((async (
            method: string,
            params?: Record<string, unknown>,
          ) => {
            if (stage !== "markers" && captured && !navigated && method === "Page.getFrameTree") {
              await navigateChild();
            }
            const result = await (
              send as (method: string, params?: Record<string, unknown>) => Promise<unknown>
            )(method, params);
            if (
              method === "DOM.setAttributeValue" &&
              params?.name === BROWSER_REF_MARKER_ATTRIBUTE
            ) {
              captured = true;
              if (stage === "markers" && !navigated) {
                await navigateChild();
              }
            }
            return result;
          }) as typeof cdp.send);
          return cdp;
        });
      try {
        const response = await snapshotRoutes(target)(
          "/snapshot",
          stage !== "response" ? { frame: "#selected" } : {},
          stage === "sibling" ? 200 : 500,
        );
        expect(navigated).toBe(true);
        if (stage === "sibling") {
          const snapshot = response.body as { refs: Record<string, { name?: string }> };
          const ref = Object.entries(snapshot.refs).find(
            ([, info]) => info.name === "Original child",
          )![0];
          await clickViaPlaywright({ ...target, ref, timeoutMs: 1_000 });
          expect(await frameButton(page, "#selected").textContent()).toBe("Selected clicked");
          return;
        }
        expect(response.body).toEqual({
          error: "Error: Frame changed while its browser snapshot was being captured; retry.",
        });
      } finally {
        captureSpy.mockRestore();
        sessionSpy.mockRestore();
      }
    }),
  30_000,
);

it.each(["frame", "ai"])(
  "resets %s snapshot deltas after same-URL iframe navigation",
  (scope) =>
    withBrowser(async (target, page) => {
      await page.setContent('<iframe srcdoc="<button>Original document</button>"></iframe>');
      await frameButton(page, "iframe", "Original document").waitFor();
      const routes = snapshotRoutes(target);
      const capture = async () =>
        (await routes("/snapshot", scope === "frame" ? { frame: "iframe" } : {})).body;
      const original = await capture();
      expect(original).not.toHaveProperty("newElements");
      await frameButton(page).evaluate((button) => {
        button.insertAdjacentHTML("afterend", "<button>Same-document addition</button>");
      });
      const mutated = await capture();
      expect(mutated).toHaveProperty("newElements");
      expect(mutated).toHaveProperty(
        "snapshot",
        expect.stringMatching(/button "Same-document addition".*\[new\]/),
      );
      await replaceFrame(page, "iframe", "Replacement document");
      const replacement = await capture();
      expect(replacement).not.toHaveProperty("newElements");
    }),
  30_000,
);

it.for(["ai", "frame"] as const)(
  "preserves the requested %s snapshot ref through a labeled screenshot",
  { timeout: 30_000 },
  (mode) =>
    withBrowser(async (target, page) => {
      await page.setContent(`<style>html,body{margin:0}h1{margin:0;line-height:40px}button{display:block;width:120px;height:60px;background:rgb(224,79,95);border:0}iframe{display:block}</style>
            <h1>Page heading</h1><button onclick="document.querySelector('output').textContent='clicked'">Target</button><output></output>
            <a href="https://parent.test/docs">Parent docs</a>
            <iframe srcdoc="<style>html,body{margin:0}button{display:block;width:180px;height:80px;background:rgb(224,79,95);border:0}</style><button onclick=&quot;document.querySelector('output').textContent='clicked'&quot;>Frame target</button><output></output><a href='https://frame.test/docs'>Frame docs</a>"></iframe>`);
      await frameButton(page).waitFor();
      const routes = snapshotRoutes(target);
      const snapshot = await routes(
        "/snapshot",
        mode === "frame" ? { frame: "iframe", urls: true } : {},
      );
      const result = snapshot.body as {
        snapshot: string;
        refs: Record<string, { name?: string }>;
      };
      const name = mode === "frame" ? "Frame target" : "Target";
      const ref = Object.entries(result.refs).find(([, info]) => info.name === name)![0];
      if (mode === "frame") {
        expect.soft(result.snapshot).toContain("Frame docs -> https://frame.test/docs");
        expect.soft(result.snapshot).not.toContain("Parent docs -> https://parent.test/docs");
      }
      const capture = await routes("/screenshot", { ref, labels: true });
      const screenshot = capture.body as { path: string; annotations: AnnotationItem[] };
      try {
        const buffer = await fs.readFile(screenshot.path);
        await expectImage(page, buffer, mode === "frame" ? [180, 80] : [120, 60], [
          [10, 40, [224, 79, 95]],
        ]);
        expect(screenshot.annotations).toContainEqual(expect.objectContaining({ ref, name }));
        await clickViaPlaywright({ ...target, ref, timeoutMs: 1_000 });
        const scope = mode === "frame" ? page.frameLocator("iframe") : page;
        expect(await scope.locator("output").textContent()).toBe("clicked");
      } finally {
        await fs.rm(screenshot.path);
      }
    }),
);

it.each(["native full page", "resized viewport"] as const)(
  "captures %s edges without changing page geometry",
  (mode) =>
    withBrowser(async (target, launcherPage, wsUrl) => {
      const native = mode === "native full page";
      if (native) {
        await launcherPage.evaluate(() => scrollTo(0, 420));
      } else {
        await resizeViewportViaPlaywright({ ...target, width: 1280, height: 720 });
      }
      const page = native ? launcherPage : await getPageForTargetId(target);
      const before = await page.evaluate(readGeometry);
      const buffer = native
        ? await captureScreenshot({ wsUrl, fullPage: true, headless: true })
        : (await takeScreenshotViaPlaywright(target)).buffer;
      await expectImage(page, buffer, native ? [before.width, 1200] : [1280, 720], [
        [native ? 20 : 1250, 20, [16, 42, 67]],
        [native ? before.width - 20 : 1250, native ? 1180 : 700, [51, 78, 104]],
      ]);
      expect(await page.evaluate(readGeometry)).toEqual(before);
    }),
  30_000,
);

it("keeps device DPR, screen, scroll, and touch across viewport, element, labels, and full-page captures", async () => {
  await withBrowser(async (target) => {
    await setDeviceViaPlaywright({ ...target, name: "iPhone 13" });
    await resizeViewportViaPlaywright({ ...target, width: 640, height: 480 });
    await setDeviceViaPlaywright({ ...target, name: "iPhone 13" });
    await resizeViewportViaPlaywright({ ...target, width: 390, height: 664 });
    const page = await getPageForTargetId(target);
    await page.evaluate(() => scrollTo(0, 420));
    const before = await page.evaluate(readGeometry);
    expect(before).toMatchObject({ width: 390, height: 664, dpr: 3, touch: 1 });
    const { refs } = await snapshotRoleViaPlaywright(target);
    const ref = Object.keys(refs)[0]!;
    for (const mode of ["viewport", "element", "ref", "labels", "fullpage"] as const) {
      const result: { buffer: Buffer; annotations?: AnnotationItem[] } =
        mode === "labels"
          ? await screenshotWithLabelsViaPlaywright({ ...target, refs })
          : await takeScreenshotViaPlaywright({
              ...target,
              element: mode === "element" ? "button" : undefined,
              ref: mode === "ref" ? ref : undefined,
              fullPage: mode === "fullpage",
            });
      const element = mode === "element" || mode === "ref";
      await expectImage(
        page,
        result.buffer,
        element ? [360, 180] : [1170, mode === "fullpage" ? 3600 : 1992],
        [
          element
            ? [180, 90, [224, 79, 95]]
            : [100, mode === "fullpage" ? 3000 : 1700, [51, 78, 104]],
        ],
      );
      if (result.annotations) {
        expect(result.annotations[0]?.box).toEqual({ x: 99, y: 54, width: 360, height: 180 });
      }
      expect(await page.evaluate(readGeometry), mode).toEqual(before);
    }

    await resizeViewportViaPlaywright({ ...target, width: 640, height: 480 });
    await page.locator("button").evaluate((element) => {
      element.style.width = "900px";
      element.style.height = "700px";
    });
    const touch = await page.evaluate(() => navigator.maxTouchPoints);
    const cropped = await takeScreenshotViaPlaywright({ ...target, element: "button" });
    await expectImage(page, cropped.buffer, [900, 700], [[850, 350, [224, 79, 95]]]);
    expect(await page.evaluate(() => navigator.maxTouchPoints)).toBe(touch);
  });
}, 30_000);

it.for([
  { device: "Native DPR 2", pageScale: 1, nativeDpr: 2 },
  { device: "Desktop Chrome", pageScale: 1 },
  { device: "iPhone 13", pageScale: 1 },
  { device: "iPhone 13", pageScale: 2 },
  { device: "Native classic scrollbars", pageScale: 1, nativeDpr: 1, showScrollbars: true },
])(
  "returns image-space annotations through routes for $device at page scale $pageScale",
  { timeout: 60_000 },
  ({ device, pageScale, nativeDpr, showScrollbars }, { annotate }) =>
    withBrowser(
      async (target) => {
        if (nativeDpr === undefined) {
          await setDeviceViaPlaywright({ ...target, name: device });
        }
        const page = await getPageForTargetId(target);
        if (showScrollbars) {
          await page.addStyleTag({
            content:
              "html{overflow-y:scroll}::-webkit-scrollbar{width:16px;height:16px}::-webkit-scrollbar-thumb{background:#888}button{left:480px}",
          });
        }
        const zoom = await page.context().newCDPSession(page);
        await zoom.send("Emulation.setPageScaleFactor", { pageScaleFactor: pageScale });
        await zoom.detach();
        const routes = snapshotRoutes(target);
        for (const mode of ["viewport", "fullpage", "element", "snapshot"] as const) {
          await page.evaluate(() => scrollTo(0, 420));
          if (mode === "element") {
            await setSectionTransform(page, "translate(0.5px, 0.5px)");
          }
          const before = await page.evaluate(readGeometry);
          if (showScrollbars) {
            expect(before.width - before.visual.width).toBe(16);
          }
          const response = await routes(mode === "snapshot" ? "/snapshot" : "/screenshot", {
            labels: true,
            ...(mode === "snapshot"
              ? {}
              : {
                  fullPage: mode === "fullpage",
                  element: mode === "element" ? "section" : undefined,
                }),
          });
          const result = response.body as {
            path?: string;
            imagePath?: string;
            annotations: AnnotationItem[];
          };
          const imagePath = result.path ?? result.imagePath!;
          try {
            const buffer = await fs.readFile(imagePath);
            await annotate(`${device} ${mode}`, { path: imagePath });
            const metadata = await getImageMetadata(buffer);
            const imageWidth = metadata!.width;
            const imageHeight = metadata!.height;
            const annotation = result.annotations.find(({ name }) => name === "Target")!;
            const pixels = (await inspectImage(page, buffer)).box!;
            for (const coordinate of ["x", "y", "width", "height"] as const) {
              expect(
                Math.abs(annotation.box[coordinate] - pixels[coordinate]),
                `${device} ${mode} ${coordinate}: annotation=${annotation.box[coordinate]} pixels=${pixels[coordinate]}`,
              ).toBeLessThanOrEqual(1);
            }
            expect(Math.max(imageWidth, imageHeight)).toBeLessThanOrEqual(2000);
            if (device === "iPhone 13" && mode === "fullpage") {
              expect(imageHeight).toBe(2000);
              expect(imageHeight / 1200).toBeLessThan(before.dpr);
            }
          } finally {
            await fs.rm(imagePath);
            if (mode === "element") {
              await setSectionTransform(page, "");
            }
          }
        }
      },
      nativeDpr,
      showScrollbars,
    ),
);
