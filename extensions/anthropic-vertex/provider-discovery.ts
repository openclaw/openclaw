/**
 * Provider discovery descriptor for Anthropic Vertex. This variant is used by
 * catalog surfaces that need the provider contract without full plugin entry setup.
 */
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { hasAnthropicVertexAvailableAuth, resolveAnthropicVertexConfigApiKey } from "./region.js";

const PROVIDER_ID = "anthropic-vertex";
const GCP_VERTEX_CREDENTIALS_MARKER = "gcp-vertex-credentials";

/** Anthropic Vertex provider discovery descriptor. */
export const anthropicVertexProviderDiscovery = {
  id: PROVIDER_ID,
  label: "Anthropic Vertex",
  docsPath: "/providers/models",
  auth: [],
  catalog: {
    order: "simple",
    // Descriptor reads need ADC facts; catalog execution owns model/runtime loading.
    run: async (ctx) => {
      const { runAnthropicVertexCatalog } = await import("./provider-catalog-runtime.js");
      return await runAnthropicVertexCatalog(ctx);
    },
  },
  resolveConfigApiKey: ({ env }: { env: NodeJS.ProcessEnv }) =>
    resolveAnthropicVertexConfigApiKey(env),
  resolveSyntheticAuth: () => {
    if (!hasAnthropicVertexAvailableAuth()) {
      return undefined;
    }
    return {
      apiKey: GCP_VERTEX_CREDENTIALS_MARKER,
      source: "gcp-vertex-credentials (ADC)",
      mode: "api-key",
    };
  },
} satisfies ProviderPlugin;

export default anthropicVertexProviderDiscovery;
