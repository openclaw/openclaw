// Checks model reference normalization across manifests and runtime owners.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

beforeEach(() => {
  resetPluginRuntimeStateForTest();
  clearPluginMetadataLifecycleCaches();
});

afterEach(() => {
  resetPluginRuntimeStateForTest();
  clearPluginMetadataLifecycleCaches();
});

describe("normalizeStaticProviderModelId", () => {
  it("keeps the built-in Anthropic alias table aligned with the bundled manifest", async () => {
    const manifest: {
      modelIdNormalization: {
        providers: { anthropic: { aliases: Record<string, string> } };
      };
    } = JSON.parse(
      await fs.readFile(
        new URL("../../extensions/anthropic/openclaw.plugin.json", import.meta.url),
        "utf8",
      ),
    );
    const aliases = manifest.modelIdNormalization.providers.anthropic.aliases;
    expect(Object.keys(aliases).length).toBeGreaterThan(0);
    for (const [alias, target] of Object.entries(aliases)) {
      expect(
        normalizeStaticProviderModelId("anthropic", alias, { allowManifestNormalization: false }),
        alias,
      ).toBe(target);
    }
  });
});

const execFileAsync = promisify(execFile);

function createModelNormalizerGeneration() {
  const pluginRegistry = createEmptyPluginRegistry();
  pluginRegistry.providers.push({
    pluginId: "foreign-owner",
    source: "foreign-owner.ts",
    provider: {
      id: "foreign",
      hookAliases: ["fixture"],
      label: "Foreign alias",
      auth: [],
      normalizeModelId: () => "foreign-model",
    },
  });
  pluginRegistry.providers.push({
    pluginId: "fixture-owner",
    source: "fixture-owner.ts",
    provider: {
      id: "fixture",
      hookAliases: ["fixture-alias"],
      label: "Fixture",
      auth: [],
      normalizeModelId(this: ProviderPlugin, { modelId }) {
        return `${this.pluginId}-${modelId}`;
      },
    },
  });
  const metadataSnapshot = createPluginMetadataSnapshotFixture({
    plugins: [
      { id: "foreign-owner", providers: ["foreign"] },
      { id: "fixture-owner", providers: ["fixture"] },
    ],
  });
  return { metadataSnapshot, pluginRegistry };
}

describe("provider model normalization bridge", () => {
  it("keeps an empty generation authoritative over ambient request hooks", () => {
    const generation = createModelNormalizerGeneration();
    expect(
      withPluginRuntimeRegistryScope(generation.pluginRegistry, () =>
        withPluginRuntimeGenerationScope(
          { ...generation, pluginRegistry: createEmptyPluginRegistry() },
          () =>
            normalizeProviderModelIdWithRuntime({
              provider: "fixture",
              context: { provider: "fixture", modelId: "model" },
            }),
        ),
      ),
    ).toBeUndefined();
  });

  it("does not borrow an active provider on a request registry miss", () => {
    const generation = createModelNormalizerGeneration();
    setActivePluginRegistry(generation.pluginRegistry, "another-gateway");
    const normalize = () =>
      normalizeProviderModelIdWithRuntime({
        provider: "fixture",
        context: { provider: "fixture", modelId: "model" },
      });
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
      // The bundler places this bridge at the dist root, unlike its source directory.
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
        bridge.withPluginRuntimeGenerationScope(createModelNormalizerGeneration(), () =>
          bridge.normalizeProviderModelIdWithRuntime({
            provider: "fixture",
            context: { provider: "fixture", modelId: "model" },
          }),
        ),
      ).toBe("fixture-owner-model");
    });
  });

  it("applies source manifest normalization once without an executable hook", async () => {
    await withTempDir("openclaw-model-normalizer-source-", async (root) => {
      // Native source execution protects the same contract before runtime preparation.
      const script = `
        const { pathToFileURL } = await import("node:url");
        const load = (file) => import(pathToFileURL(${JSON.stringify(process.cwd())} + "/" + file).href);
        const { normalizeModelRef } = await load("src/agents/model-ref-shared.ts");
        const { createPluginMetadataSnapshotFixture } = await load("src/plugins/plugin-metadata.test-support.ts");
        const { createEmptyPluginRegistry } = await load("src/plugins/registry-empty.ts");
        const { withPluginRuntimeGenerationScope } = await load("src/plugins/runtime/generation-scope.ts");
        const { withPluginRuntimeRegistryScope } = await load("src/plugins/runtime/gateway-request-scope.ts");
        const { withPluginMetadataSnapshotScope } = await load("src/plugins/current-plugin-metadata-snapshot.ts");
        const metadataSnapshot = createPluginMetadataSnapshotFixture({ plugins: [{
          id: "fixture", providers: ["fixture"],
          modelIdNormalization: { providers: { fixture: { stripPrefixes: ["compat/"] } } },
        }] });
        const empty = withPluginRuntimeGenerationScope(
          { metadataSnapshot, pluginRegistry: createEmptyPluginRegistry() },
          () => normalizeModelRef("fixture", "compat/compat/model"),
        );
        const registry = createEmptyPluginRegistry();
        registry.providers.push({ pluginId: "fixture", provider: { id: "fixture", label: "Fixture", auth: [] } });
        const request = withPluginMetadataSnapshotScope(metadataSnapshot,
          () => withPluginRuntimeRegistryScope(registry,
            () => normalizeModelRef("fixture", "compat/compat/model")),
          { trustConfigIdentity: true });
        const unprepared = withPluginMetadataSnapshotScope(metadataSnapshot,
          () => normalizeModelRef("fixture", "compat/compat/model"),
          { trustConfigIdentity: true });
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
      expect(JSON.parse(stdout)).toEqual({
        empty: { provider: "fixture", model: "compat/model" },
        request: { provider: "fixture", model: "compat/model" },
        unprepared: { provider: "fixture", model: "compat/model" },
      });
    });
  });
});
