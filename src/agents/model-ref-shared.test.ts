import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearManifestModelIdNormalizationCacheForTest } from "../plugins/manifest-model-id-normalization.js";
import { normalizeStaticProviderModelId } from "./model-ref-shared.js";

const tempDirs: string[] = [];

function writePluginManifest(root: string, id: string, manifest: Record<string, unknown>) {
  const pluginDir = path.join(root, id);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "openclaw.plugin.json"), JSON.stringify(manifest), "utf8");
}

function useBundledPluginManifestFixture(manifest: Record<string, unknown>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-model-ref-"));
  tempDirs.push(root);
  const bundledRoot = path.join(root, "bundled");
  writePluginManifest(bundledRoot, "nvidia", manifest);
  vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", bundledRoot);
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
  clearManifestModelIdNormalizationCacheForTest();
  return root;
}

afterEach(() => {
  vi.unstubAllEnvs();
  clearManifestModelIdNormalizationCacheForTest();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("normalizeStaticProviderModelId", () => {
  it("re-adds the nvidia prefix for bare model ids", () => {
    useBundledPluginManifestFixture({
      id: "nvidia",
      modelIdNormalization: { providers: { nvidia: { prefixWhenBare: "nvidia" } } },
    });

    expect(normalizeStaticProviderModelId("nvidia", "nemotron-3-super-120b-a12b")).toBe(
      "nvidia/nemotron-3-super-120b-a12b",
    );
  });

  it("does not double-prefix already prefixed models", () => {
    useBundledPluginManifestFixture({
      id: "nvidia",
      modelIdNormalization: { providers: { nvidia: { prefixWhenBare: "nvidia" } } },
    });

    expect(normalizeStaticProviderModelId("nvidia", "nvidia/nemotron-3-super-120b-a12b")).toBe(
      "nvidia/nemotron-3-super-120b-a12b",
    );
  });

  it("prefers current bundled model normalization over stale persisted bundled metadata", () => {
    const root = useBundledPluginManifestFixture({
      id: "nvidia",
      modelIdNormalization: { providers: { nvidia: { prefixWhenBare: "nvidia" } } },
    });
    const staleRoot = path.join(root, "stale");
    writePluginManifest(staleRoot, "nvidia", { id: "nvidia" });
    const installsPath = path.join(root, "state", "plugins", "installs.json");
    fs.mkdirSync(path.dirname(installsPath), { recursive: true });
    fs.writeFileSync(
      installsPath,
      JSON.stringify({ plugins: [{ rootDir: path.join(staleRoot, "nvidia"), origin: "bundled" }] }),
      "utf8",
    );
    clearManifestModelIdNormalizationCacheForTest();

    expect(normalizeStaticProviderModelId("nvidia", "nemotron-3-super-120b-a12b")).toBe(
      "nvidia/nemotron-3-super-120b-a12b",
    );
  });
});
