import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  generatePixelArtPlaceholder,
  writePixelArtPlaceholder,
} from "./pixel-art-placeholder.js";

describe("pixel-art placeholder", () => {
  it("generates deterministic PNG output for the same prompt and seed", async () => {
    const first = await generatePixelArtPlaceholder({
      prompt: "forest tree tile",
      seed: "oak-1",
    });
    const second = await generatePixelArtPlaceholder({
      prompt: "forest tree tile",
      seed: "oak-1",
    });

    expect(first.mimeType).toBe("image/png");
    expect(first.buffer.equals(second.buffer)).toBe(true);
    expect(first.metadata).toMatchObject({
      biome: "forest",
      subject: "tree",
      style: "stardew-placeholder",
      seed: "oak-1",
    });
    expect(first.buffer.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });

  it("writes the generated PNG to disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pixel-art-placeholder-"));
    const outputPath = join(dir, "farm-crop.png");

    const result = await writePixelArtPlaceholder({
      prompt: "farm crop patch",
      seed: "plot-7",
      outputPath,
    });

    const written = await readFile(outputPath);
    expect(result.outputPath).toBe(outputPath);
    expect(written.equals(result.asset.buffer)).toBe(true);
  });
});
