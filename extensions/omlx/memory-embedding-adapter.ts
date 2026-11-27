import type { MemoryEmbeddingProviderAdapter } from "openclaw/plugin-sdk/embedding-provider-adapter";
import { findNormalizedProviderKey } from "openclaw/plugin-sdk/provider-model-metadata";
import {
  OMLX_API_KEY_ENV_VAR,
  OMLX_DEFAULT_BASE_URL,
  OMLX_LOCAL_API_KEY,
  OMLX_PROVIDER_ID,
} from "./defaults.js";

// oMLX serves EmbeddingGemma 2 images, and audio once the model's embedding_audio_enabled
// setting is on; otherwise memory skips the audio file with oMLX's message as the warning.
const EMBEDDINGGEMMA_2_MODEL = /(?:^|[/\\])embeddinggemma-2(?:[-:._]|$)/iu;

export const omlxEmbeddingProvider: MemoryEmbeddingProviderAdapter = {
  id: OMLX_PROVIDER_ID,
  transport: "remote",
  authProviderId: OMLX_PROVIDER_ID,
  mediaModalities: ({ model }) =>
    EMBEDDINGGEMMA_2_MODEL.test(model.trim()) ? ["image", "audio"] : [],
  create: async (options) => {
    const { embeddingProviderOwnsDestination, getMemoryEmbeddingProvider } =
      await import("openclaw/plugin-sdk/memory-core-host-engine-embeddings");
    const adapter = getMemoryEmbeddingProvider("openai-compatible", options.config);
    if (!adapter) {
      throw new Error("The OpenAI-compatible embedding provider is unavailable.");
    }
    const providerId = options.provider?.trim() || OMLX_PROVIDER_ID;
    const providers = options.config.models?.providers;
    const configuredKey = findNormalizedProviderKey(providers, providerId);
    let configured = configuredKey ? providers?.[configuredKey] : undefined;
    const baseUrl = options.remote?.baseUrl ?? configured?.baseUrl ?? OMLX_DEFAULT_BASE_URL;
    let config = options.config;
    if (
      configuredKey &&
      configured &&
      embeddingProviderOwnsDestination({ baseUrl, providerBaseUrl: configured.baseUrl })
    ) {
      const { resolveOmlxHeaders, withoutOmlxAuthentication } = await import("./connection.js");
      const remoteKey = options.remote?.apiKey;
      const hasRemoteKey = Boolean(typeof remoteKey === "string" ? remoteKey.trim() : remoteKey);
      const hasRemoteAuth =
        hasRemoteKey ||
        Object.entries(options.remote?.headers ?? {}).some(
          ([name, value]) => name.trim().toLowerCase() === "authorization" && Boolean(value.trim()),
        );
      if (hasRemoteAuth) {
        configured = withoutOmlxAuthentication(configured);
      }
      const { headers, hasHeaderAuth } = await resolveOmlxHeaders(
        { config, env: process.env },
        configured,
        options.remote?.headers,
      );
      let apiKey = configured.apiKey;
      if (!hasHeaderAuth && !hasRemoteAuth && apiKey === OMLX_API_KEY_ENV_VAR) {
        apiKey = process.env[OMLX_API_KEY_ENV_VAR];
        if (!apiKey) {
          const { resolveApiKeyForProvider } =
            await import("openclaw/plugin-sdk/provider-auth-runtime");
          apiKey = (
            await resolveApiKeyForProvider({
              provider: providerId,
              cfg: config,
              agentDir: options.agentDir,
            })
          ).apiKey;
        }
      }
      config = {
        ...config,
        models: {
          ...config.models,
          providers: {
            ...providers,
            [configuredKey]: {
              ...configured,
              headers,
              apiKey: hasHeaderAuth || apiKey === OMLX_LOCAL_API_KEY ? undefined : apiKey,
            },
          },
        },
      };
    }
    const result = await adapter.create({
      ...options,
      config,
      provider: providerId,
      mediaFormat: "items",
      remote: {
        ...options.remote,
        baseUrl,
      },
    });
    return {
      ...result,
      provider: result.provider ? { ...result.provider, id: OMLX_PROVIDER_ID } : null,
      ...(result.runtime ? { runtime: { ...result.runtime, id: OMLX_PROVIDER_ID } } : {}),
    };
  },
};
