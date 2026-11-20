import type { MemoryEmbeddingProviderAdapter } from "openclaw/plugin-sdk/embedding-provider-adapter";
import { findNormalizedProviderKey } from "openclaw/plugin-sdk/provider-model-metadata";
import {
  RAPID_MLX_API_KEY_ENV_VAR,
  RAPID_MLX_DEFAULT_BASE_URL,
  RAPID_MLX_LOCAL_API_KEY,
  RAPID_MLX_PROVIDER_ID,
} from "./defaults.js";

export const rapidMlxEmbeddingProvider: MemoryEmbeddingProviderAdapter = {
  id: RAPID_MLX_PROVIDER_ID,
  transport: "remote",
  authProviderId: RAPID_MLX_PROVIDER_ID,
  create: async (options) => {
    const { embeddingProviderOwnsDestination, getMemoryEmbeddingProvider } =
      await import("openclaw/plugin-sdk/memory-core-host-engine-embeddings");
    const adapter = getMemoryEmbeddingProvider("openai-compatible", options.config);
    if (!adapter) {
      throw new Error("The OpenAI-compatible embedding provider is unavailable.");
    }
    const providerId = options.provider?.trim() || RAPID_MLX_PROVIDER_ID;
    const providers = options.config.models?.providers;
    const configuredKey = findNormalizedProviderKey(providers, providerId);
    let configured = configuredKey ? providers?.[configuredKey] : undefined;
    const baseUrl = options.remote?.baseUrl ?? configured?.baseUrl ?? RAPID_MLX_DEFAULT_BASE_URL;
    let config = options.config;
    if (
      configuredKey &&
      configured &&
      embeddingProviderOwnsDestination({ baseUrl, providerBaseUrl: configured.baseUrl })
    ) {
      const { resolveRapidMlxHeaders, withoutRapidMlxAuthentication } =
        await import("./connection.js");
      const remoteKey = options.remote?.apiKey;
      const hasRemoteKey = Boolean(typeof remoteKey === "string" ? remoteKey.trim() : remoteKey);
      const hasRemoteAuth =
        hasRemoteKey ||
        Object.entries(options.remote?.headers ?? {}).some(
          ([name, value]) => name.trim().toLowerCase() === "authorization" && Boolean(value.trim()),
        );
      if (hasRemoteAuth) {
        configured = withoutRapidMlxAuthentication(configured);
      }
      const { headers, hasHeaderAuth } = await resolveRapidMlxHeaders(
        { config, env: process.env },
        configured,
        options.remote?.headers,
      );
      let apiKey = configured.apiKey;
      if (!hasHeaderAuth && !hasRemoteAuth && apiKey === RAPID_MLX_API_KEY_ENV_VAR) {
        apiKey = process.env[RAPID_MLX_API_KEY_ENV_VAR];
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
              apiKey: hasHeaderAuth || apiKey === RAPID_MLX_LOCAL_API_KEY ? undefined : apiKey,
            },
          },
        },
      };
    }
    const result = await adapter.create({
      ...options,
      config,
      provider: providerId,
      remote: {
        ...options.remote,
        baseUrl,
      },
    });
    return {
      ...result,
      provider: result.provider ? { ...result.provider, id: RAPID_MLX_PROVIDER_ID } : null,
      ...(result.runtime ? { runtime: { ...result.runtime, id: RAPID_MLX_PROVIDER_ID } } : {}),
    };
  },
};
