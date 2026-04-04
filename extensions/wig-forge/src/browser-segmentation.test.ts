import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

describe("wig-forge browser segmentation helper", () => {
  it("extracts a compact mask around the clicked color region", async () => {
    const helper = await loadSegmentationHelper();
    const width = 8;
    const height = 8;
    const data = new Uint8ClampedArray(width * height * 4);

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = (y * width + x) * 4;
        const inCenter = x >= 2 && x <= 5 && y >= 2 && y <= 5;
        data[index] = inCenter ? 220 : 20;
        data[index + 1] = inCenter ? 60 : 24;
        data[index + 2] = inCenter ? 60 : 28;
        data[index + 3] = 255;
      }
    }

    const result = helper.segmentPixelBuffer({
      data,
      width,
      height,
      seedX: 3,
      seedY: 3,
    });

    expect(result.ok).toBe(true);
    expect(result.bounds.width).toBeLessThan(width);
    expect(result.bounds.height).toBeLessThan(height);
    expect(result.coverage).toBeGreaterThan(0.15);
    expect(result.coverage).toBeLessThan(0.7);
  });

  it("converts a MediaPipe-like confidence mask into a connected object mask", async () => {
    const helper = await loadSegmentationHelper();
    const width = 8;
    const height = 8;
    const confidences = new Float32Array(width * height);

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        const inCenter = x >= 2 && x <= 5 && y >= 2 && y <= 5;
        confidences[index] = inCenter ? 0.92 : 0.04;
      }
    }

    const result = helper.segmentConfidenceMask({
      confidences,
      width,
      height,
      seedX: 3,
      seedY: 3,
      qualityScore: 0.87,
    });

    expect(result.ok).toBe(true);
    expect(result.bounds.width).toBe(4);
    expect(result.bounds.height).toBe(4);
    expect(result.seedConfidence).toBeGreaterThan(0.8);
    expect(result.coverage).toBeGreaterThan(0.15);
    expect(result.coverage).toBeLessThan(0.5);
  });
});

async function loadSegmentationHelper(): Promise<{
  segmentPixelBuffer: (params: {
    data: Uint8ClampedArray;
    width: number;
    height: number;
    seedX: number;
    seedY: number;
  }) => { ok: boolean; bounds: { width: number; height: number }; coverage: number };
  segmentConfidenceMask: (params: {
    confidences: Float32Array;
    width: number;
    height: number;
    seedX: number;
    seedY: number;
    qualityScore?: number;
  }) => {
    ok: boolean;
    bounds: { width: number; height: number };
    coverage: number;
    seedConfidence: number;
  };
}> {
  const filePath = path.join(
    "/Users/alma/openclaw/extensions/wig-forge/browser-extension",
    "segmentation.js",
  );
  const source = await fs.readFile(filePath, "utf8");
  const context = vm.createContext({
    globalThis: {},
    Float32Array,
    Uint8Array,
    Uint32Array,
    Uint8ClampedArray,
    Math,
    console,
  });
  new vm.Script(source).runInContext(context);
  return (context.globalThis as { WigForgeSegmentation: unknown }).WigForgeSegmentation as {
    segmentPixelBuffer: (params: {
      data: Uint8ClampedArray;
      width: number;
      height: number;
      seedX: number;
      seedY: number;
    }) => { ok: boolean; bounds: { width: number; height: number }; coverage: number };
  };
}
