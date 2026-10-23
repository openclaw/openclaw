import fs from "node:fs/promises";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir, withTempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyA2uiAssets } from "./copy-a2ui.mjs";

describe("canvas a2ui copy", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_A2UI_SKIP_MISSING", undefined);
    vi.stubEnv("OPENCLAW_SPARSE_PROFILE", undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  function withA2uiFixture(run: (paths: { srcDir: string; outDir: string }) => Promise<void>) {
    return withTempWorkspace(
      { rootDir: resolvePreferredOpenClawTmpDir(), prefix: "openclaw-a2ui-" },
      ({ dir }) => run({ srcDir: path.join(dir, "src"), outDir: path.join(dir, "out") }),
    );
  }

  it("throws a helpful error when assets are missing", async () => {
    await withA2uiFixture(async (paths) => {
      await expect(copyA2uiAssets(paths)).rejects.toThrow('Run "pnpm canvas:a2ui:bundle"');
    });
  });

  it("skips missing assets when OPENCLAW_A2UI_SKIP_MISSING=1", async () => {
    await withA2uiFixture(async (paths) => {
      vi.stubEnv("OPENCLAW_A2UI_SKIP_MISSING", "1");
      await expect(copyA2uiAssets(paths)).resolves.toBeUndefined();
    });
  });

  it("skips missing assets when OPENCLAW_SPARSE_PROFILE is set", async () => {
    await withA2uiFixture(async (paths) => {
      vi.stubEnv("OPENCLAW_SPARSE_PROFILE", "core");
      await expect(copyA2uiAssets(paths)).resolves.toBeUndefined();
    });
  });

  it("copies nested bundled assets and removes stale output", async () => {
    await withA2uiFixture(async ({ srcDir, outDir }) => {
      const nestedAssetDir = path.join(srcDir, "assets", "demo");
      await fs.mkdir(nestedAssetDir, { recursive: true });
      await fs.mkdir(outDir, { recursive: true });
      await fs.writeFile(path.join(srcDir, "a2ui.bundle.js"), "console.log(1);", "utf8");
      await fs.writeFile(path.join(srcDir, "a2ui-v0.9.bundle.js"), "console.log(2);", "utf8");
      await fs.writeFile(path.join(nestedAssetDir, "sample.txt"), "nested-asset", "utf8");
      await fs.writeFile(path.join(outDir, "stale.txt"), "stale-output", "utf8");

      await copyA2uiAssets({ srcDir, outDir });

      await expect(
        Promise.all(
          ["a2ui.bundle.js", "a2ui-v0.9.bundle.js", "assets/demo/sample.txt"].map((file) =>
            fs.readFile(path.join(outDir, file), "utf8"),
          ),
        ),
      ).resolves.toEqual(["console.log(1);", "console.log(2);", "nested-asset"]);
      await expect(fs.stat(path.join(outDir, "stale.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("rejects overlapping source and output directories before cleaning output", async () => {
    await withA2uiFixture(async ({ srcDir }) => {
      await fs.mkdir(srcDir, { recursive: true });
      await fs.writeFile(path.join(srcDir, "a2ui.bundle.js"), "console.log(1);", "utf8");
      await fs.writeFile(path.join(srcDir, "a2ui-v0.9.bundle.js"), "console.log(2);", "utf8");

      await expect(copyA2uiAssets({ srcDir, outDir: srcDir })).rejects.toThrow("must not overlap");
      await expect(fs.readFile(path.join(srcDir, "a2ui.bundle.js"), "utf8")).resolves.toBe(
        "console.log(1);",
      );
      await expect(copyA2uiAssets({ srcDir, outDir: path.join(srcDir, "dist") })).rejects.toThrow(
        "must not overlap",
      );
    });
  });
});
