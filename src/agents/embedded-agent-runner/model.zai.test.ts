import { fileURLToPath } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildManifestModelProviderConfig } from "../../plugin-sdk/provider-catalog-shared.js";
import { acquireBundledCapabilityRuntimeRegistry } from "../../plugins/bundled-capability-runtime.js";
import { loadPluginManifest } from "../../plugins/manifest.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import { AuthStorage, ModelRegistry } from "../sessions/index.js";
import { resolveModelAsync } from "./model.js";

const rootDir = fileURLToPath(new URL("../../../extensions/zai", import.meta.url));
const loaded = loadPluginManifest(rootDir);
if (!loaded.ok) {
  throw new Error(loaded.error);
}
const metadataSnapshot = createPluginMetadataSnapshotFixture({
  plugins: [{ ...loaded.manifest, rootDir }],
});
const catalog = expectDefined(loaded.manifest.modelCatalog?.providers?.zai, "Z.AI catalog");
const staticProvider = buildManifestModelProviderConfig({ providerId: "zai", catalog });
const generalEndpoint = "https://api.z.ai/api/paas/v4";
const config: OpenClawConfig = {
  plugins: { allow: ["zai"], entries: { zai: { enabled: true } } },
};
let captured: Awaited<ReturnType<typeof acquireBundledCapabilityRuntimeRegistry>>;

beforeAll(async () => {
  captured = await acquireBundledCapabilityRuntimeRegistry({
    pluginIds: ["zai"],
    config,
    preferBuiltPluginArtifacts: false,
    env: {
      ...process.env,
      OPENCLAW_BUNDLED_PLUGINS_DIR: fileURLToPath(new URL("../../../extensions", import.meta.url)),
    },
  });
});
afterAll(() => captured?.release());

it.each([
  { baseUrl: generalEndpoint, modelBaseUrl: undefined },
  { baseUrl: "https://api.z.ai/api/coding/paas/v4", modelBaseUrl: undefined },
  { baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4", modelBaseUrl: undefined },
  { baseUrl: "https://proxy.example.test/zai", modelBaseUrl: undefined },
  { baseUrl: generalEndpoint, modelBaseUrl: "https://open.bigmodel.cn/api/coding/paas/v4" },
])("resolves retained Z.AI catalog models with $baseUrl / $modelBaseUrl", async (route) => {
  const { baseUrl } = route;
  const cfg: OpenClawConfig = {
    ...config,
    models: {
      providers: {
        zai: {
          api: "openai-completions",
          baseUrl,
          models: route.modelBaseUrl
            ? staticProvider.models.map((model) => ({ ...model, baseUrl: route.modelBaseUrl }))
            : [],
        },
      },
    },
  };
  await withPluginRuntimeGenerationScope(
    { metadataSnapshot, pluginRegistry: captured.registry },
    async () => {
      const authStorage = AuthStorage.inMemory({});
      const modelRegistry = ModelRegistry.fromCapturedSources(authStorage, "/unused/models.json", {
        modelsJsonContents: null,
        pluginCatalogs: [],
        pluginMetadataSnapshot: metadataSnapshot,
        staticProviderConfigs: { zai: staticProvider },
      });
      for (const modelId of ["glm-5.3", "glm-5.3-flash"]) {
        expect(modelRegistry.find("zai", modelId)?.baseUrl).toBe(generalEndpoint);
        const resolved = await resolveModelAsync("zai", modelId, "/unused-zai-agent", cfg, {
          authStorage,
          modelRegistry,
          skipAgentDiscovery: true,
          authProfileMode: "api_key",
        });
        expect(resolved.error).toBeUndefined();
        expect(resolved.model).toMatchObject({
          id: modelId,
          baseUrl: route.modelBaseUrl ?? baseUrl,
          api: "openai-completions",
        });
        expect(modelRegistry.find("zai", modelId)?.baseUrl).toBe(generalEndpoint);
      }
    },
  );
});
