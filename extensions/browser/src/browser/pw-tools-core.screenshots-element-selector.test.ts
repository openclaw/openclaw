import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { CDPSession } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PageState } from "./pw-session-contracts.js";
import {
  getPwToolsCoreSessionMocks,
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
  setPwToolsCoreCurrentRefLocator,
} from "./pw-tools-core.test-harness.js";

const imageSize = vi.hoisted(() => ({ width: 1280, height: 720, active: false }));
vi.mock("openclaw/plugin-sdk/media-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/media-runtime")>();
  return {
    ...actual,
    getImageMetadata: (...args: Parameters<typeof actual.getImageMetadata>) =>
      imageSize.active ? Promise.resolve(imageSize) : actual.getImageMetadata(...args),
  };
});

installPwToolsCoreTestHooks();
beforeEach(() => {
  imageSize.active = false;
});
afterEach(() => {
  imageSize.active = false;
});
const sessionMocks = getPwToolsCoreSessionMocks();
const { takeScreenshotViaPlaywright: capture, screenshotWithLabelsViaPlaywright: captureLabels } =
  await import("./pw-tools-core.interactions.content.js");

const target = { cdpUrl: "http://127.0.0.1:18792", targetId: "T1" };

it("rejects fullPage for element or ref screenshots", async () => {
  const locator = {};
  setPwToolsCoreCurrentRefLocator(locator);
  setPwToolsCoreCurrentPage({ locator: () => ({ first: () => locator }) });
  for (const selector of [{ element: "#x" }, { ref: "1" }]) {
    await expect(capture({ ...target, ...selector, fullPage: true })).rejects.toThrow(
      /fullPage is not supported/i,
    );
  }
});
it("does not start a queued screenshot after its timeout", async () => {
  const previous = createDeferred<void>();
  const state = sessionMocks.ensurePageState() as unknown as PageState;
  state.emulation = { transitionTail: previous.promise };
  const screenshot = vi.fn(async () => Buffer.from("late"));
  setPwToolsCoreCurrentPage({ screenshot });

  try {
    await expect(capture({ ...target, timeoutMs: 10 })).rejects.toThrow("timed out");
    const pending = state.emulation.transitionTail;
    previous.resolve();
    await pending;
    expect(screenshot).not.toHaveBeenCalled();
    expect(sessionMocks.restoreRoleRefsForTarget).not.toHaveBeenCalled();
  } finally {
    previous.resolve();
  }
});
it("skips a cancelled queued labeled screenshot", async () => {
  const previous = createDeferred<void>();
  const state = sessionMocks.ensurePageState() as unknown as PageState;
  state.emulation = { transitionTail: previous.promise };
  const page = { screenshot: vi.fn(), evaluate: vi.fn() };
  setPwToolsCoreCurrentPage(page);
  const controller = new AbortController();
  const pending = captureLabels({
    ...target,
    signal: controller.signal,
    refs: {},
  });
  const rejected = expect(pending).rejects.toThrow("request closed");
  try {
    await vi.waitFor(() => expect(state.emulation?.transitionTail).not.toBe(previous.promise));
    controller.abort(new Error("request closed"));
    previous.resolve();
    await rejected;
    expect(page.screenshot).not.toHaveBeenCalled();
    expect(page.evaluate).not.toHaveBeenCalled();
  } finally {
    previous.resolve();
  }
});

it.each(["Emulation.setTouchEmulationEnabled", "Playwright.screenshot"])(
  "rejects mutations behind an interrupted %s until it settles",
  async (blockedMethod) => {
    vi.useFakeTimers();
    const started = createDeferred<void>();
    const release = createDeferred<void>();
    const waitAt = async (method: string) => {
      if (method === blockedMethod) {
        started.resolve();
        await release.promise;
      }
    };
    const send = vi.fn(async (method: string) => {
      await waitAt(method);
      return method === "Page.getLayoutMetrics"
        ? {
            cssVisualViewport: { pageX: 0, pageY: 0, scale: 1 },
            cssContentSize: { x: 0, y: 0, width: 390, height: 664 },
          }
        : { data: Buffer.from("capture").toString("base64") };
    });
    const session = { send } as unknown as CDPSession;
    const page = {
      viewportSize: () => ({ width: 390, height: 664 }),
      setViewportSize: vi.fn(async () => {}),
      screenshot: vi.fn(async () => {
        await waitAt("Playwright.screenshot");
        return Buffer.from("capture");
      }),
    };
    setPwToolsCoreCurrentPage(page);
    const state = sessionMocks.ensurePageState() as unknown as PageState;
    state.emulation = {
      session: Promise.resolve(session),
      ...(blockedMethod === "Playwright.screenshot"
        ? {}
        : { metricsOwner: { session, viewport: { width: 390, height: 664 } } }),
      touch: { session, enabled: true },
    };
    const { resizeViewportViaPlaywright } = await import("./pw-tools-core.snapshot.js");
    const { setDeviceViaPlaywright } = await import("./pw-tools-core.state.js");
    const controller = new AbortController();
    const outcome = (operation: Promise<unknown>) => operation.then(() => "success", String);
    const screenshot = outcome(capture({ ...target, timeoutMs: 25, signal: controller.signal }));
    const mutations: Promise<string>[] = [];
    try {
      await started.promise;
      const outcomes: string[] = [];
      const recordOutcome = (operation: Promise<unknown>) => {
        const pending = outcome(operation).then((value) => {
          outcomes.push(value);
          return value;
        });
        mutations.push(pending);
      };
      recordOutcome(resizeViewportViaPlaywright({ ...target, width: 800, height: 600 }));
      if (blockedMethod === "Playwright.screenshot") {
        controller.abort(new Error("request closed"));
      }
      await vi.advanceTimersByTimeAsync(25);
      expect(await screenshot).toContain(
        blockedMethod === "Playwright.screenshot" ? "request closed" : "timed out",
      );
      recordOutcome(setDeviceViaPlaywright({ ...target, name: "Desktop Chrome" }));
      await vi.advanceTimersByTimeAsync(0);
      expect(outcomes).toEqual([
        expect.stringContaining("close and reopen this tab"),
        expect.stringContaining("close and reopen this tab"),
      ]);
      expect(page.setViewportSize).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await screenshot;
      await Promise.all(mutations);
      await state.emulation?.transitionTail;
      vi.useRealTimers();
    }
    expect(page.setViewportSize).not.toHaveBeenCalled();
    await resizeViewportViaPlaywright({ ...target, width: 1280, height: 720 });
    expect(page.setViewportSize).toHaveBeenCalledExactlyOnceWith({ width: 1280, height: 720 });
  },
);

describe("screenshot annotations", () => {
  type Rect = [number, number, number, number];
  const box = ([x, y, width, height]: Rect) => ({ x, y, width, height });
  const screenshot = vi.fn(async () => Buffer.from("PNG"));
  const boundingBox = vi.fn<() => Promise<ReturnType<typeof box> | null>>();
  const view = { x: 0, y: 0, width: 1280, height: 720, fullWidth: 1280, nativeCaptureWidth: 1280 };
  const evaluate = async (arg: unknown) => (typeof arg === "function" ? view : true);
  const annotation = (number: number, rect: Rect, name?: string) =>
    Object.assign(
      { ref: `e${number}`, number, role: "button", box: box(rect) },
      name ? { name } : {},
    );
  const refs = (count: number): Record<string, { role: string; name?: string }> =>
    Object.fromEntries(Array.from({ length: count }, (_, i) => [`e${i + 1}`, { role: "button" }]));
  const captureAnnotations = (options: Partial<Parameters<typeof captureLabels>[0]> = {}) =>
    captureLabels({ ...target, refs: refs(1), ...options });
  beforeEach(() => {
    imageSize.active = true;
    view.y = 0;
    screenshot.mockReset().mockResolvedValue(Buffer.from("PNG"));
    boundingBox.mockReset().mockResolvedValue(box([0, 0, 1, 1]));
    setPwToolsCoreCurrentPage({ evaluate, screenshot, url: () => "https://example.com" });
    setPwToolsCoreCurrentRefLocator({ boundingBox });
  });

  it.each([false, true])(
    "projects annotations and counts skipped refs (full page: %s)",
    async (fullPage) => {
      view.y = fullPage ? 1000 : 100;
      const targets = refs(fullPage ? 154 : 2);
      if (fullPage) {
        boundingBox
          .mockRejectedValueOnce(new Error("detached"))
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(box([10, 20, 30, 40]))
          .mockResolvedValueOnce(box([50, 60, 70, 80]));
      } else {
        targets.e1 = { role: "button", name: "Submit" };
        boundingBox
          .mockResolvedValueOnce(box([10, 200, 50, 20]))
          .mockResolvedValueOnce(box([0, 5000, 50, 20]));
      }
      const result = await captureAnnotations({
        refs: targets,
        ...(fullPage ? { fullPage: true } : { type: "png" }),
      });
      expect(result.annotations.slice(0, 2)).toEqual(
        fullPage
          ? [annotation(3, [10, 1020, 30, 40]), annotation(4, [50, 1060, 70, 80])]
          : [annotation(1, [10, 200, 50, 20], "Submit"), annotation(2, [0, 5000, 50, 20])],
      );
      expect(result.annotations).toHaveLength(fullPage ? 150 : 2);
      expect(result).toMatchObject({ labels: fullPage ? 150 : 1, skipped: fullPage ? 4 : 1 });
      if (fullPage) {
        expect(boundingBox).toHaveBeenCalledTimes(152);
        expect(screenshot).toHaveBeenCalledWith(expect.objectContaining({ fullPage: true }));
      } else {
        expect(screenshot).toHaveBeenCalledWith(expect.objectContaining({ type: "png" }));
        expect(screenshot).not.toHaveBeenCalledWith(expect.objectContaining({ fullPage: true }));
      }
    },
  );

  it("rejects unresolved elements", async () => {
    boundingBox.mockResolvedValueOnce(null);
    await expect(captureAnnotations({ ref: "missing" })).rejects.toThrow(/element not found/i);
  });
});
