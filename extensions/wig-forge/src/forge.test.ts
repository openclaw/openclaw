import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { resolveWigForgeConfig } from "./config.js";
import { inferSlot, mintForgeAsset, rollRarity } from "./forge.js";
import { WigForgeStore } from "./store.js";

describe("wig-forge forge logic", () => {
  it("infers neck slot from tie-like hints", () => {
    expect(
      inferSlot({
        nameHint: "Silver Tie",
        styleTags: ["formal"],
        width: 96,
        height: 220,
      }),
    ).toBe("neck");
  });

  it("decays novelty for duplicate fingerprints", () => {
    const first = rollRarity({
      novelty: 0.8,
      duplicateCount: 0,
      maskQuality: 0.8,
      taskQuality: 0.8,
      styleFit: 0.8,
      luck: 0.8,
    });
    const duplicate = rollRarity({
      novelty: 0.8,
      duplicateCount: 2,
      maskQuality: 0.8,
      taskQuality: 0.8,
      styleFit: 0.8,
      luck: 0.8,
    });
    expect(duplicate.effectiveNovelty).toBeLessThan(first.effectiveNovelty);
    expect(duplicate.score).toBeLessThan(first.score);
  });

  it("mints an asset record with stored files", async () => {
    const tempRoot = await fsMkdtemp();
    const store = new WigForgeStore(tempRoot);
    const png = await sharp({
      create: {
        width: 96,
        height: 120,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([
        {
          input: await sharp({
            create: {
              width: 28,
              height: 78,
              channels: 4,
              background: { r: 220, g: 40, b: 50, alpha: 1 },
            },
          })
            .png()
            .toBuffer(),
          left: 34,
          top: 22,
        },
      ])
      .png()
      .toBuffer();
    const asset = await mintForgeAsset({
      toolCallId: "tool-1",
      input: {
        sourceDataUrl: `data:image/png;base64,${png.toString("base64")}`,
        nameHint: "Ribbon Tie",
        styleTags: ["formal", "silver"],
        luck: 0.91,
      },
      config: resolveWigForgeConfig(),
      store,
      agentId: "designer-bot",
    });

    expect(asset.slot).toBe("neck");
    expect(asset.files.sourcePath).toBeDefined();
    expect(asset.files.spritePath).toBeDefined();
    expect(asset.files.previewPath).toBeDefined();
    expect(asset.files.svgPath).toBeDefined();
    expect(asset.files.width).toBeLessThan(96);
    expect(asset.files.height).toBeLessThan(120);
    expect(asset.assembly?.contour.length).toBeGreaterThanOrEqual(12);
    expect(asset.assembly?.mount.scale).toBeGreaterThan(0.8);
    expect(asset.rarity).toMatch(/common|uncommon|rare|epic|mythic/);

    const fs = await import("node:fs/promises");
    const svgText = await fs.readFile(String(asset.files.svgPath), "utf8");
    expect(svgText).toContain("<svg");
    expect(svgText).toContain("<path");
  });
});

async function fsMkdtemp(): Promise<string> {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  return await fs.mkdtemp(path.join(os.tmpdir(), "wig-forge-test-"));
}
