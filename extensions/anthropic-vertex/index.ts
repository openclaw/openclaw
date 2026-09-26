/**
 * Anthropic Vertex provider plugin entry. It registers implicit ADC-backed
 * catalog discovery, Anthropic replay policy, thinking profiles, and auth markers.
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { readConfiguredProviderCatalogEntries } from "openclaw/plugin-sdk/provider-catalog-shared";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { runAnthropicVertexCatalog } from "./provider-catalog-runtime.js";
import {
  normalizeAnthropicVertexResolvedModel,
  resolveAnthropicVertexDynamicModel,
} from "./provider-catalog.js";
import { anthropicVertexProviderDiscovery } from "./provider-discovery.js";
import { resolveThinkingProfile } from "./provider-policy-api.js";

const PROVIDER_ID = "anthropic-vertex";

/** Provider entry for Anthropic Claude models served through Google Vertex AI. */
export default definePluginEntry({
  id: PROVIDER_ID,
  name: "Anthropic Vertex Provider",
  description: "Bundled Anthropic Vertex provider plugin",
  register(api) {
    api.registerProvider({
      ...anthropicVertexProviderDiscovery,
      catalog: {
        order: "simple",
        run: runAnthropicVertexCatalog,
      },
      resolveDynamicModel: ({ provider, modelId, modelRegistry, providerConfig }) =>
        modelRegistry.find(provider, modelId) ??
        resolveAnthropicVertexDynamicModel(modelId, providerConfig?.baseUrl),
      ...buildProviderReplayFamilyHooks({ family: "native-anthropic-by-model" }),
      normalizeResolvedModel: ({ modelId, model }) =>
        normalizeAnthropicVertexResolvedModel(modelId, model),
      resolveThinkingProfile,
      augmentModelCatalog: ({ config }) =>
        readConfiguredProviderCatalogEntries({
          config,
          providerId: PROVIDER_ID,
        }),
    });
  },
});
