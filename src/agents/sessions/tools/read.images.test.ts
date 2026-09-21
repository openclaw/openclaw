import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createReadTool } from "./read.js";

const imageOps = vi.hoisted(() => ({
  convertImageToPng: vi.fn(),
  probe: vi.fn(),
  encode: vi.fn(),
}));

vi.mock("../../../media/image-ops.js", () => ({
  convertImageToPng: imageOps.convertImageToPng,
  createImageProcessor: () => ({ probe: imageOps.probe, encode: imageOps.encode }),
}));

describe("read image snapshots", () => {
  beforeEach(() => {
    imageOps.convertImageToPng.mockReset();
    imageOps.probe.mockReset();
    imageOps.encode.mockReset();
  });

  it.each([
    { mime: "image/png", autoResizeImages: false, resize: false },
    { mime: " IMAGE/JPG ; quality=80", autoResizeImages: false, resize: false },
    { mime: "image/png", autoResizeImages: true, resize: false },
    { mime: "image/jpeg", autoResizeImages: true, resize: true },
    { mime: "image/bmp", autoResizeImages: false, resize: false },
    { mime: "image/bmp", autoResizeImages: true, resize: true },
  ])(
    "captures $mime after detection and before processing ($autoResizeImages/$resize)",
    async ({ mime, autoResizeImages, resize }) => {
      const source = Buffer.from([91, 1, 1, 1, 92]);
      const borrowed = source.subarray(1, 4);
      const snapshot = Buffer.from([2, 2, 2]);
      const detected = createDeferred();
      const mimeResult = createDeferred<string>();
      const entered = createDeferred();
      const release = createDeferred();
      const converted = mime === "image/bmp";
      const observe = async (input: Buffer) => {
        entered.resolve();
        await release.promise;
        expect(input).toEqual(snapshot);
      };
      imageOps.convertImageToPng.mockImplementation(async (input: Buffer) => {
        await observe(input);
        return Buffer.from(input);
      });
      imageOps.probe.mockImplementation(async (input: Buffer) => {
        if (!converted) {
          await observe(input);
        }
        expect(input).toEqual(snapshot);
        return { width: resize ? 4000 : 1, height: 1, orientation: null };
      });
      imageOps.encode.mockImplementation(async (input: Buffer) => {
        await Promise.resolve();
        expect(input).toEqual(snapshot);
        return {
          data: Buffer.from(input),
          mimeType: "image/png",
          width: 2000,
          height: 1,
          resized: true,
          withinBudget: true,
        };
      });
      const tool = createReadTool("/workspace", {
        autoResizeImages,
        get modelHasVision() {
          if (!autoResizeImages && !converted) {
            // This getter runs after MIME detection, immediately before image capture.
            queueMicrotask(() => borrowed.fill(3));
          }
          return true;
        },
        operations: {
          access: async () => {},
          readFile: async () => borrowed,
          detectImageMimeType: async () => {
            detected.resolve();
            return mimeResult.promise;
          },
        },
      });
      const pending = tool.execute("read", { path: "synthetic-image" });
      await detected.promise;
      borrowed.fill(2);
      mimeResult.resolve(mime);
      if (autoResizeImages || converted) {
        await entered.promise;
        borrowed.fill(3);
        release.resolve();
      }
      const result = await pending;
      const mimeType = resize || converted || mime === "image/png" ? "image/png" : "image/jpeg";
      const notes = [
        `Read image file [${mimeType}]`,
        ...(converted ? ["[Image converted from image/bmp to image/png.]"] : []),
        ...(resize
          ? [
              "[Image: original 4000x1, displayed at 2000x1. Multiply coordinates by 2.00 to map to original image.]",
            ]
          : []),
      ].join("\n");
      expect(result).toEqual({
        content: [
          { type: "text", text: notes },
          { type: "image", mimeType, data: snapshot.toString("base64") },
        ],
        details: { kind: "image", content: notes, mimeType },
      });
      expect(borrowed).toEqual(Buffer.from([3, 3, 3]));
      borrowed.fill(4);
      expect(result.content[1]).toMatchObject({ data: snapshot.toString("base64") });
      expect(source).toEqual(Buffer.from([91, 4, 4, 4, 92]));
    },
  );
});
