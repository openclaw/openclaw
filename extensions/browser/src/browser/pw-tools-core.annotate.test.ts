import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
  setPwToolsCoreCurrentRefLocator,
} from "./pw-tools-core.test-harness.js";

installPwToolsCoreTestHooks();
const imageSize = vi.hoisted(() => ({ width: 1280, height: 720 }));
vi.mock("openclaw/plugin-sdk/media-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/media-runtime")>()),
  getImageMetadata: async () => imageSize,
}));
const { screenshotWithLabelsViaPlaywright } = await import("./pw-tools-core.interactions.js");
const target = { cdpUrl: "http://127.0.0.1:18792", targetId: "T1" };
const screenshot = vi.fn(async () => Buffer.from("PNG"));
const boundingBox =
  vi.fn<() => Promise<{ x: number; y: number; width: number; height: number } | null>>();
const view = { x: 0, y: 0, width: 1280, height: 720, fullWidth: 1280, nativeCaptureWidth: 1280 };
const evaluate = vi.fn(async (arg: unknown) => (typeof arg === "function" ? view : true));
function capture(options: Partial<Parameters<typeof screenshotWithLabelsViaPlaywright>[0]> = {}) {
  return screenshotWithLabelsViaPlaywright({
    ...target,
    refs: { e1: { role: "button" } },
    ...options,
  });
}
beforeEach(() => {
  imageSize.width = 1280;
  view.y = 0;
  screenshot.mockReset().mockResolvedValue(Buffer.from("PNG"));
  boundingBox.mockReset().mockResolvedValue({ x: 0, y: 0, width: 1, height: 1 });
  evaluate.mockClear();
  setPwToolsCoreCurrentPage({ evaluate, screenshot, url: () => "https://example.com" });
  setPwToolsCoreCurrentRefLocator({ boundingBox });
});

describe("labeled screenshots", () => {
  it("projects viewport annotations and counts off-screen refs without drawing them", async () => {
    view.y = 100;
    boundingBox
      .mockResolvedValueOnce({ x: 10, y: 200, width: 50, height: 20 })
      .mockResolvedValueOnce({ x: 0, y: 5000, width: 50, height: 20 });
    const result = await capture({
      refs: { e1: { role: "button", name: "Submit" }, e2: { role: "button" } },
      type: "png",
    });
    expect(screenshot).toHaveBeenCalledWith(expect.objectContaining({ type: "png" }));
    expect(screenshot).not.toHaveBeenCalledWith(expect.objectContaining({ fullPage: true }));
    expect(result.annotations).toEqual([
      {
        ref: "e1",
        number: 1,
        role: "button",
        name: "Submit",
        box: { x: 10, y: 200, width: 50, height: 20 },
      },
      { ref: "e2", number: 2, role: "button", box: { x: 0, y: 5000, width: 50, height: 20 } },
    ]);
    expect(result.labels).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it("stops full-page geometry reads at the label budget, counting detached and tail refs", async () => {
    view.y = 1000;
    boundingBox
      .mockRejectedValueOnce(new Error("detached"))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ x: 10, y: 20, width: 30, height: 40 })
      .mockResolvedValueOnce({ x: 50, y: 60, width: 70, height: 80 });
    const result = await capture({
      refs: Object.fromEntries(
        ["e1", "e2", "e3", "e4", "e5", "e6"].map((ref) => [ref, { role: "button" }]),
      ),
      fullPage: true,
      maxLabels: 2,
    });
    expect(result.annotations).toEqual([
      { ref: "e3", number: 3, role: "button", box: { x: 10, y: 1020, width: 30, height: 40 } },
      { ref: "e4", number: 4, role: "button", box: { x: 50, y: 1060, width: 70, height: 80 } },
    ]);
    expect(result.labels).toBe(2);
    expect(result.skipped).toBe(4);
    expect(boundingBox).toHaveBeenCalledTimes(4);
    expect(screenshot).toHaveBeenCalledWith(expect.objectContaining({ fullPage: true }));
  });

  it("captures the resolved element and projects annotations relative to it", async () => {
    imageSize.width = 200;
    boundingBox
      .mockResolvedValueOnce({ x: 50, y: 100, width: 200, height: 300 })
      .mockResolvedValueOnce({ x: 60, y: 110, width: 30, height: 20 });
    const elementScreenshot = vi.fn(async () => Buffer.from("ELEM"));
    setPwToolsCoreCurrentRefLocator({
      boundingBox,
      elementHandle: async () => ({
        screenshot: elementScreenshot,
        scrollIntoViewIfNeeded: async () => {},
        dispose: async () => {},
      }),
    });
    const result = await capture({ ref: "container" });
    expect(elementScreenshot).toHaveBeenCalledOnce();
    expect(result.annotations).toHaveLength(1);
    expect(result.annotations[0]?.box).toEqual({ x: 10, y: 10, width: 30, height: 20 });
  });

  it("rejects unresolved elements", async () => {
    boundingBox.mockResolvedValueOnce(null);
    await expect(capture({ ref: "missing" })).rejects.toThrow(/element not found/i);
  });
});
