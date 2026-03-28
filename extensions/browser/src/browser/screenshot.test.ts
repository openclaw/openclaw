import { Transformer } from "@napi-rs/image";
import { describe, expect, it } from "vitest";
import { normalizeBrowserScreenshot } from "./screenshot.js";

describe("browser screenshot normalization", () => {
  it("shrinks oversized images to <=2000x2000 and <=5MB", async () => {
    const bigPng = await Transformer.fromRgbaPixels(
      Buffer.alloc(2100 * 2100 * 4, 0x0c),
      2100,
      2100,
    ).png({ compressionType: 0 });

    const normalized = await normalizeBrowserScreenshot(bigPng, {
      maxSide: 2000,
      maxBytes: 5 * 1024 * 1024,
    });

    expect(normalized.buffer.byteLength).toBeLessThanOrEqual(5 * 1024 * 1024);
    const meta = await new Transformer(normalized.buffer).metadata();
    expect(Number(meta.width)).toBeLessThanOrEqual(2000);
    expect(Number(meta.height)).toBeLessThanOrEqual(2000);
    expect(normalized.buffer[0]).toBe(0xff);
    expect(normalized.buffer[1]).toBe(0xd8);
  }, 120_000);

  it("keeps already-small screenshots unchanged", async () => {
    // Create a simple 800x600 JPEG using raw RGBA pixels
    const width = 800;
    const height = 600;
    const rgbaPixels = Buffer.alloc(width * height * 4);
    // Fill with red color (R=255, G=0, B=0, A=255)
    for (let i = 0; i < rgbaPixels.length; i += 4) {
      rgbaPixels[i] = 255; // R
      rgbaPixels[i + 1] = 0; // G
      rgbaPixels[i + 2] = 0; // B
      rgbaPixels[i + 3] = 255; // A
    }

    const jpeg = await Transformer.fromRgbaPixels(rgbaPixels, width, height).jpeg(80);

    const normalized = await normalizeBrowserScreenshot(jpeg, {
      maxSide: 2000,
      maxBytes: 5 * 1024 * 1024,
    });

    expect(normalized.buffer.equals(jpeg)).toBe(true);
  });
});
