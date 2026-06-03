import fs from "node:fs/promises";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir, withTempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyA2uiAssets } from "./copy-a2ui.mjs";

const ORIGINAL_SKIP_MISSING = process.env.OPENCLAW_A2UI_SKIP_MISSING;
const ORIGINAL_SPARSE_PROFILE = process.env.OPENCLAW_SPARSE_PROFILE;

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

  it("throws a helpful error when assets are missing", async () => {
    await withA2uiFixture(async (dir) => {
      await expect(copyA2uiAssets({ srcDir: dir, outDir: path.join(dir, "out") })).rejects.toThrow(
        'Run "pnpm canvas:a2ui:bundle"',
      );
    });
  });

  it("skips missing assets when OPENCLAW_A2UI_SKIP_MISSING=1", async () => {
    await withA2uiFixture(async (dir) => {
      process.env.OPENCLAW_A2UI_SKIP_MISSING = "1";
      await expect(
        copyA2uiAssets({ srcDir: dir, outDir: path.join(dir, "out") }),
      ).resolves.toBeUndefined();
    });
  });

  it("skips missing assets when OPENCLAW_SPARSE_PROFILE is set", async () => {
    await withA2uiFixture(async (dir) => {
      process.env.OPENCLAW_SPARSE_PROFILE = "core";
      await expect(
        copyA2uiAssets({ srcDir: dir, outDir: path.join(dir, "out") }),
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

      await copyA2uiAssets({ srcDir, outDir });

      await expect(
        fs.readFile(path.join(outDir, "assets", "providers", "google.png"), "utf8"),
      ).resolves.toBe("google-asset");
      await expect(
        fs.readFile(path.join(outDir, "assets", "providers", "x.png"), "utf8"),
      ).resolves.toBe("x-asset");
      await expect(fs.readFile(path.join(outDir, "granola.png"), "utf8")).resolves.toBe(
        "legacy-granola-asset",
      );
    });
  });
});
