import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { afterEach, beforeEach, expect, it } from "vitest";
import { STATE_SCHEMA_GENERATOR_INPUTS } from "../../scripts/lib/state-schema-inline-plugin.mts";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { normalizeStaticProviderModelId } from "./model-ref-shared.js";
import { normalizeProviderModelIdWithRuntime } from "./provider-model-normalization.runtime.js";

function resetRuntime() {
  resetPluginRuntimeStateForTest();
  clearPluginMetadataLifecycleCaches();
}
beforeEach(resetRuntime);
afterEach(resetRuntime);

const normalizationRequest = {
  provider: "fixture",
  context: { provider: "fixture", modelId: "model" },
};
const normalize = () => normalizeProviderModelIdWithRuntime(normalizationRequest);

it("aligns built-in Anthropic aliases with the bundled manifest", async () => {
  const manifestUrl = new URL("../../extensions/anthropic/openclaw.plugin.json", import.meta.url);
  const manifest: {
    modelIdNormalization: {
      providers: { anthropic: { aliases: Record<string, string> } };
    };
  } = JSON.parse(await fs.readFile(manifestUrl, "utf8"));
  const aliases = manifest.modelIdNormalization.providers.anthropic.aliases;
  expect(Object.keys(aliases).length).toBeGreaterThan(0);
  for (const [alias, target] of Object.entries(aliases)) {
    expect(
      normalizeStaticProviderModelId("anthropic", alias, { allowManifestNormalization: false }),
      alias,
    ).toBe(target);
  }
});

const execFileAsync = promisify(execFile);

function createGeneration() {
  const pluginRegistry = createEmptyPluginRegistry();
  const register = (
    id: string,
    hookAliases: string[],
    normalizeModelId: ProviderPlugin["normalizeModelId"],
  ) => {
    pluginRegistry.providers.push({
      pluginId: `${id}-owner`,
      source: `${id}-owner.ts`,
      provider: { id, label: id, auth: [], hookAliases, normalizeModelId },
    });
  };
  register("foreign", ["fixture"], () => "foreign-model");
  register("fixture", ["fixture-alias"], function (this: ProviderPlugin, { modelId }) {
    return `${this.pluginId}-${modelId}`;
  });
  const metadataSnapshot = createPluginMetadataSnapshotFixture({
    plugins: ["foreign", "fixture"].map((id) => ({ id: `${id}-owner`, providers: [id] })),
  });
  return { metadataSnapshot, pluginRegistry };
}

it("keeps an empty generation authoritative over ambient request hooks", () => {
  const generation = createGeneration();
  expect(
    withPluginRuntimeRegistryScope(generation.pluginRegistry, () =>
      withPluginRuntimeGenerationScope(
        { ...generation, pluginRegistry: createEmptyPluginRegistry() },
        normalize,
      ),
    ),
  ).toBeUndefined();
});

it("does not borrow an active provider on a request registry miss", () => {
  const generation = createGeneration();
  setActivePluginRegistry(generation.pluginRegistry, "another-gateway");
  expect(normalize()).toBe("fixture-owner-model");
  expect(withPluginRuntimeRegistryScope(createEmptyPluginRegistry(), normalize)).toBeUndefined();
});

it("invokes the retained normalizer from the packaged runtime layout", async () => {
  await withTempDir("openclaw-model-normalizer-", async (root) => {
    const dist = path.join(root, "dist");
    await fs.mkdir(dist, { recursive: true });
    await fs.writeFile(path.join(root, "package.json"), '{"type":"module"}');
    for (const schema of STATE_SCHEMA_GENERATOR_INPUTS) {
      await fs.copyFile(path.resolve(schema), path.join(dist, path.basename(schema)));
    }
    const bridgePath = path.join(dist, "model-reference.js");
    // Exercise the dist-root layout, not the source-relative bridge path.
    await build({
      stdin: {
        contents: `export * from "./src/agents/provider-model-normalization.runtime.ts";
            export { withPluginRuntimeGenerationScope } from "./src/plugins/runtime/generation-scope.ts";`,
        resolveDir: process.cwd(),
      },
      outfile: bridgePath,
      bundle: true,
      platform: "node",
      format: "esm",
      tsconfig: path.resolve("tsconfig.json"),
    });
    // SAFETY: This test emits the actual typed bridge into a standalone package.
    const bridge = createRequire(import.meta.url)(
      bridgePath,
    ) as typeof import("./provider-model-normalization.runtime.js") & {
      withPluginRuntimeGenerationScope: typeof withPluginRuntimeGenerationScope;
    };

    expect(
      bridge.withPluginRuntimeGenerationScope(createGeneration(), () =>
        bridge.normalizeProviderModelIdWithRuntime(normalizationRequest),
      ),
    ).toBe("fixture-owner-model");
  });
});

it("applies source manifest normalization once without an executable hook", async () => {
  await withTempDir("openclaw-model-normalizer-source-", async (root) => {
    const script = `
        const { pathToFileURL } = await import("node:url");
        const load = (file) => import(pathToFileURL(${JSON.stringify(process.cwd())} + "/" + file).href);
        const { normalizeModelRef } = await load("src/agents/model-ref-shared.ts");
        const { createPluginMetadataSnapshotFixture } = await load("src/plugins/plugin-metadata.test-support.ts");
        const { createEmptyPluginRegistry } = await load("src/plugins/registry-empty.ts");
        const { withPluginRuntimeGenerationScope } = await load("src/plugins/runtime/generation-scope.ts");
        const { withPluginRuntimeRegistryScope } = await load("src/plugins/runtime/gateway-request-scope.ts");
        const { withPluginMetadataSnapshotScope } = await load("src/plugins/current-plugin-metadata-snapshot.ts");
        const normalize = () => normalizeModelRef("fixture", "compat/compat/model");
        const metadataSnapshot = createPluginMetadataSnapshotFixture({ plugins: [{
          id: "fixture", providers: ["fixture"],
          modelIdNormalization: { providers: { fixture: { stripPrefixes: ["compat/"] } } },
        }] });
        const empty = withPluginRuntimeGenerationScope(
          { metadataSnapshot, pluginRegistry: createEmptyPluginRegistry() },
          normalize,
        );
        const registry = createEmptyPluginRegistry();
        registry.providers.push({ pluginId: "fixture", provider: { id: "fixture", label: "Fixture", auth: [] } });
        const withMetadata = (run) => withPluginMetadataSnapshotScope(metadataSnapshot, run, { trustConfigIdentity: true });
        const request = withMetadata(() => withPluginRuntimeRegistryScope(registry, normalize));
        const unprepared = withMetadata(normalize);
        process.stdout.write(JSON.stringify({ empty, request, unprepared }));
      `;
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", path.resolve("scripts/tsx.mjs"), "--input-type=module", "--eval", script],
      {
        env: {
          ...process.env,
          OPENCLAW_HOME: root,
          OPENCLAW_STATE_DIR: path.join(root, "state"),
          OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        },
      },
    );
    const normalized = { provider: "fixture", model: "compat/model" };
    expect(JSON.parse(stdout)).toEqual({
      empty: normalized,
      request: normalized,
      unprepared: normalized,
    });
  });
});
