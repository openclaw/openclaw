import {
  isMissingEmbeddingApiKeyError,
  type MemoryEmbeddingProviderAdapter,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  createOciEmbeddingProvider,
  DEFAULT_OCI_EMBEDDING_MODEL,
  hasOciCredentials,
} from "./embedding-provider.js";

export const ociMemoryEmbeddingProviderAdapter: MemoryEmbeddingProviderAdapter = {
  id: "oci",
  defaultModel: DEFAULT_OCI_EMBEDDING_MODEL,
  transport: "remote",
  authProviderId: "oci",
  autoSelectPriority: 55,
  allowExplicitWhenConfiguredAuto: true,
  shouldContinueAutoSelection: isMissingEmbeddingApiKeyError,
  create: async (options) => {
    if (!(await hasOciCredentials())) {
      throw new Error(
        'No API key found for provider "oci". ' +
          "OCI Generative AI embeddings need a profile in ~/.oci/config (or OCI_CONFIG_FILE). " +
          "Run `openclaw configure` to add OCI, or set agents.defaults.memorySearch.provider " +
          "to another provider.",
      );
    }
    const { provider, client } = await createOciEmbeddingProvider({
      ...options,
      provider: "oci",
      fallback: "none",
    });
    return {
      provider,
      runtime: {
        id: "oci",
        cacheKeyData: {
          provider: "oci",
          region: client.region,
          model: client.model,
          compartment: client.compartmentId,
        },
      },
    };
  },
};
