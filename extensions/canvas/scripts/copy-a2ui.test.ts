// Canvas tests cover copy a2ui plugin behavior.
<<<<<<< HEAD
=======
import { createHash } from "node:crypto";
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
import fs from "node:fs/promises";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir, withTempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyA2uiAssets } from "./copy-a2ui.mjs";

const ORIGINAL_SKIP_MISSING = process.env.OPENCLAW_A2UI_SKIP_MISSING;
const ORIGINAL_SPARSE_PROFILE = process.env.OPENCLAW_SPARSE_PROFILE;
<<<<<<< HEAD
=======
const REQUIRED_COMPATIBILITY_ASSETS = [
  {
    path: path.join("assets", "providers", "google.png"),
    sha256: "cea7e50b816514db6ca0f21d9545173fae1669643c71ed475c45c7f8440dac53",
  },
  {
    path: path.join("assets", "providers", "x.png"),
    sha256: "307c5dbde1ad66164fcfa1d9787435d99906fa78e7ba7d068f2aa705e86ff5aa",
  },
  {
    path: "granola.png",
    sha256: "16bc6b7f1b1229c8b1984c64520c30141b62c24b156c7590f86ca50bdc494d34",
  },
];

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

describe("canvas a2ui copy", () => {
  beforeEach(() => {
    delete process.env.OPENCLAW_A2UI_SKIP_MISSING;
    delete process.env.OPENCLAW_SPARSE_PROFILE;
  });

  afterEach(() => {
    if (ORIGINAL_SKIP_MISSING === undefined) {
      delete process.env.OPENCLAW_A2UI_SKIP_MISSING;
    } else {
      process.env.OPENCLAW_A2UI_SKIP_MISSING = ORIGINAL_SKIP_MISSING;
    }

    if (ORIGINAL_SPARSE_PROFILE === undefined) {
      delete process.env.OPENCLAW_SPARSE_PROFILE;
    } else {
      process.env.OPENCLAW_SPARSE_PROFILE = ORIGINAL_SPARSE_PROFILE;
    }
  });

  async function withA2uiFixture(run: (dir: string) => Promise<void>) {
    await withTempWorkspace(
      { rootDir: resolvePreferredOpenClawTmpDir(), prefix: "openclaw-a2ui-" },
      async ({ dir }) => await run(dir),
    );
  }

<<<<<<< HEAD
  it("throws a helpful error when assets are missing", async () => {
    await withA2uiFixture(async (dir) => {
      await expect(
        copyA2uiAssets({ srcDir: path.join(dir, "src"), outDir: path.join(dir, "out") }),
      ).rejects.toThrow('Run "pnpm canvas:a2ui:bundle"');
=======
  it("ships provider assets and the legacy granola compatibility image", async () => {
    const srcDir = path.join(process.cwd(), "extensions", "canvas", "src", "host", "a2ui");
    const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

    for (const asset of REQUIRED_COMPATIBILITY_ASSETS) {
      const bytes = await fs.readFile(path.join(srcDir, asset.path));

      expect([...bytes.subarray(0, pngSignature.length)]).toEqual(pngSignature);
      expect(bytes.length).toBeGreaterThan(64);
      expect(sha256(bytes)).toBe(asset.sha256);
    }
  });

  it("throws a helpful error when assets are missing", async () => {
    await withA2uiFixture(async (dir) => {
      await expect(copyA2uiAssets({ srcDir: dir, outDir: path.join(dir, "out") })).rejects.toThrow(
        'Run "pnpm canvas:a2ui:bundle"',
      );
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    });
  });

  it("skips missing assets when OPENCLAW_A2UI_SKIP_MISSING=1", async () => {
    await withA2uiFixture(async (dir) => {
      process.env.OPENCLAW_A2UI_SKIP_MISSING = "1";
      await expect(
<<<<<<< HEAD
        copyA2uiAssets({ srcDir: path.join(dir, "src"), outDir: path.join(dir, "out") }),
=======
        copyA2uiAssets({ srcDir: dir, outDir: path.join(dir, "out") }),
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
      ).resolves.toBeUndefined();
    });
  });

  it("skips missing assets when OPENCLAW_SPARSE_PROFILE is set", async () => {
    await withA2uiFixture(async (dir) => {
      process.env.OPENCLAW_SPARSE_PROFILE = "core";
      await expect(
<<<<<<< HEAD
        copyA2uiAssets({ srcDir: path.join(dir, "src"), outDir: path.join(dir, "out") }),
=======
        copyA2uiAssets({ srcDir: dir, outDir: path.join(dir, "out") }),
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
      ).resolves.toBeUndefined();
    });
  });

  it("copies bundled assets to dist", async () => {
    await withA2uiFixture(async (dir) => {
      const srcDir = path.join(dir, "src");
      const outDir = path.join(dir, "dist");
      await fs.mkdir(srcDir, { recursive: true });
      await fs.writeFile(path.join(srcDir, "index.html"), "<html></html>", "utf8");
      await fs.writeFile(path.join(srcDir, "a2ui.bundle.js"), "console.log(1);", "utf8");

      await copyA2uiAssets({ srcDir, outDir });

      await expect(fs.readFile(path.join(outDir, "index.html"), "utf8")).resolves.toBe(
        "<html></html>",
      );
      await expect(fs.readFile(path.join(outDir, "a2ui.bundle.js"), "utf8")).resolves.toBe(
        "console.log(1);",
      );
    });
  });

<<<<<<< HEAD
  it("copies nested bundled assets and removes stale output", async () => {
    await withA2uiFixture(async (dir) => {
      const srcDir = path.join(dir, "src");
      const outDir = path.join(dir, "dist");
      const nestedAssetDir = path.join(srcDir, "assets", "demo");
      await fs.mkdir(nestedAssetDir, { recursive: true });
      await fs.mkdir(outDir, { recursive: true });
      await fs.writeFile(path.join(srcDir, "index.html"), "<html></html>", "utf8");
      await fs.writeFile(path.join(srcDir, "a2ui.bundle.js"), "console.log(1);", "utf8");
      await fs.writeFile(path.join(nestedAssetDir, "sample.txt"), "nested-asset", "utf8");
      await fs.writeFile(path.join(outDir, "stale.txt"), "stale-output", "utf8");
=======
  it("preserves provider assets and the legacy granola compatibility image", async () => {
    await withA2uiFixture(async (dir) => {
      const srcDir = path.join(dir, "src");
      const outDir = path.join(dir, "dist");
      const providerAssetDir = path.join(srcDir, "assets", "providers");
      await fs.mkdir(providerAssetDir, { recursive: true });
      await fs.writeFile(path.join(srcDir, "index.html"), "<html></html>", "utf8");
      await fs.writeFile(path.join(srcDir, "a2ui.bundle.js"), "console.log(1);", "utf8");
      await fs.writeFile(path.join(providerAssetDir, "google.png"), "google-asset", "utf8");
      await fs.writeFile(path.join(providerAssetDir, "x.png"), "x-asset", "utf8");
      await fs.writeFile(path.join(srcDir, "granola.png"), "legacy-granola-asset", "utf8");
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

      await copyA2uiAssets({ srcDir, outDir });

      await expect(
<<<<<<< HEAD
        fs.readFile(path.join(outDir, "assets", "demo", "sample.txt"), "utf8"),
      ).resolves.toBe("nested-asset");
      await expect(fs.stat(path.join(outDir, "stale.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("rejects overlapping source and output directories before cleaning output", async () => {
    await withA2uiFixture(async (dir) => {
      const srcDir = path.join(dir, "src");
      await fs.mkdir(srcDir, { recursive: true });
      await fs.writeFile(path.join(srcDir, "index.html"), "<html></html>", "utf8");
      await fs.writeFile(path.join(srcDir, "a2ui.bundle.js"), "console.log(1);", "utf8");

      await expect(copyA2uiAssets({ srcDir, outDir: srcDir })).rejects.toThrow("must not overlap");
      await expect(fs.readFile(path.join(srcDir, "index.html"), "utf8")).resolves.toBe(
        "<html></html>",
      );
      await expect(copyA2uiAssets({ srcDir, outDir: path.join(srcDir, "dist") })).rejects.toThrow(
        "must not overlap",
=======
        fs.readFile(path.join(outDir, "assets", "providers", "google.png"), "utf8"),
      ).resolves.toBe("google-asset");
      await expect(
        fs.readFile(path.join(outDir, "assets", "providers", "x.png"), "utf8"),
      ).resolves.toBe("x-asset");
      await expect(fs.readFile(path.join(outDir, "granola.png"), "utf8")).resolves.toBe(
        "legacy-granola-asset",
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
      );
    });
  });
});
