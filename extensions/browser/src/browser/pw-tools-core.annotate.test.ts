import { beforeEach, expect, it, vi } from "vitest";
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
const { screenshotWithLabelsViaPlaywright: captureScreenshot } =
  await import("./pw-tools-core.interactions.content.js");
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
const target = { cdpUrl: "http://127.0.0.1:18792", targetId: "T1" };
const capture = (options: Partial<Parameters<typeof captureScreenshot>[0]> = {}) =>
  captureScreenshot({ ...target, refs: refs(1), ...options });
beforeEach(() => {
  imageSize.width = 1280;
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
    const result = await capture({
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

it("captures the resolved element and projects annotations relative to it", async () => {
  imageSize.width = 200;
  boundingBox
    .mockResolvedValueOnce(box([50, 100, 200, 300]))
    .mockResolvedValueOnce(box([60, 110, 30, 20]));
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
  expect(result.annotations[0]?.box).toEqual(box([10, 10, 30, 20]));
});

it("rejects unresolved elements", async () => {
  boundingBox.mockResolvedValueOnce(null);
  await expect(capture({ ref: "missing" })).rejects.toThrow(/element not found/i);
});
