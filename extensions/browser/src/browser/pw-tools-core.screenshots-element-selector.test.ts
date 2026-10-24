import crypto from "node:crypto";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { CDPSession } from "playwright-core";
import { expect, it, vi } from "vitest";
import { DEFAULT_UPLOAD_DIR } from "./paths.js";
import type { PageState } from "./pw-session-contracts.js";
import {
  getPwToolsCoreSessionMocks,
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
  setPwToolsCoreCurrentRefLocator,
} from "./pw-tools-core.test-harness.js";

installPwToolsCoreTestHooks();
const sessionMocks = getPwToolsCoreSessionMocks();
const { takeScreenshotViaPlaywright: capture, screenshotWithLabelsViaPlaywright: captureLabels } =
  await import("./pw-tools-core.interactions.content.js");
const downloads = await import("./pw-tools-core.downloads.js");

const target = { cdpUrl: "http://127.0.0.1:18792", targetId: "T1" };

it("screenshots a ref locator", async () => {
  const refScreenshot = vi.fn(async () => Buffer.from("R"));
  setPwToolsCoreCurrentRefLocator({
    elementHandle: async () => ({
      screenshot: refScreenshot,
      scrollIntoViewIfNeeded: async () => {},
      dispose: async () => {},
    }),
  });
  const page = {};
  setPwToolsCoreCurrentPage(page);

  const res = await capture({ ...target, ref: "76", type: "jpeg", timeoutMs: 2345 });

  expect(res.buffer.toString()).toBe("R");
  expect(sessionMocks.refLocator).toHaveBeenCalledWith(page, "76");
  expect(refScreenshot).toHaveBeenCalledWith({ type: "jpeg", timeout: 0 });
});
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
it("revalidates file-chooser paths at use-time and cancels missing files", async () => {
  const missingPath = path.join(DEFAULT_UPLOAD_DIR, `vitest-missing-${crypto.randomUUID()}.txt`);
  const fileChooser = { setFiles: vi.fn(async () => {}) };
  const press = vi.fn(async () => {});
  setPwToolsCoreCurrentPage({
    waitForEvent: vi.fn(async () => fileChooser),
    keyboard: { press },
  });

  await downloads.armFileUploadViaPlaywright({ ...target, paths: [missingPath] });
  await vi.waitFor(() => expect(press).toHaveBeenCalledWith("Escape"));
  expect(fileChooser.setFiles).not.toHaveBeenCalled();
});
