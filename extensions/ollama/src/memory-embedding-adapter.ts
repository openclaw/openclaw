import { createHash } from "node:crypto";
import {
  sanitizeEmbeddingCacheHeaders,
  type MemoryEmbeddingProviderAdapter,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { readProviderJsonObjectResponse } from "openclaw/plugin-sdk/provider-http";
import { fetchConfiguredLocalOriginWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime-internal";
import { OLLAMA_DEFAULT_BASE_URL } from "./defaults.js";
import {
  DEFAULT_OLLAMA_EMBEDDING_MODEL,
  createOllamaEmbeddingProvider,
  type OllamaEmbeddingClient,
} from "./embedding-provider.js";
import { getOllamaLatestDedupeKey } from "./model-id.js";

const OLLAMA_EMBEDDING_CACHE_EXCLUDED_HEADERS = ["authorization", "content-type", "x-api-key"];

async function readOllamaEmbeddingModelDigest(
  client: OllamaEmbeddingClient,
): Promise<string | undefined> {
  let localServiceLease: { release: () => void } | undefined;
  try {
    if (client.localServiceTarget && client.acquireLocalService) {
      localServiceLease = await client.acquireLocalService(client.localServiceTarget);
    }
    const { response, release } = await fetchConfiguredLocalOriginWithSsrFGuard({
      url: `${client.baseUrl.replace(/\/$/, "")}/api/tags`,
      policy: client.ssrfPolicy,
      configuredLocalOriginBaseUrl: client.baseUrl,
      allowPodmanHostGatewayLinkLocal: client.allowPodmanHostGatewayLinkLocal,
      auditContext: "ollama-memory-model-digest",
      timeoutMs: 5000,
      init: { headers: client.headers },
    });
    try {
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        return undefined;
      }
      const data = await readProviderJsonObjectResponse(response, "Ollama model tags");
      const models: unknown[] = Array.isArray(data.models) ? data.models : [];
      const modelKey = getOllamaLatestDedupeKey(client.model);
      for (const model of models) {
        if (
          model &&
          typeof model === "object" &&
          "name" in model &&
          typeof model.name === "string" &&
          getOllamaLatestDedupeKey(model.name) === modelKey
        ) {
          return "digest" in model && typeof model.digest === "string"
            ? model.digest.trim() || undefined
            : undefined;
        }
      }
      return undefined;
    } finally {
      await release();
    }
  } catch {
    // Embedding-only proxies need not implement Ollama model discovery.
    return undefined;
  } finally {
    localServiceLease?.release();
  }
}

export const ollamaMemoryEmbeddingProviderAdapter: MemoryEmbeddingProviderAdapter = {
  id: "ollama",
  defaultModel: DEFAULT_OLLAMA_EMBEDDING_MODEL,
  transport: "remote",
  authProviderId: "ollama",
  create: async (options) => {
    const providerId = options.provider?.trim() || "ollama";
    const { provider, client } = await createOllamaEmbeddingProvider({
      ...options,
      provider: providerId,
      fallback: "none",
    });
    const identityHeaders = sanitizeEmbeddingCacheHeaders(
      client.headers,
      OLLAMA_EMBEDDING_CACHE_EXCLUDED_HEADERS,
    );
    const headersHash = identityHeaders.length
      ? createHash("sha256").update(JSON.stringify(identityHeaders)).digest("hex")
      : undefined;
    const modelDigest = await readOllamaEmbeddingModelDigest(client);
    // Keep the shipped default endpoint identity; the digest versions its model content.
    // Explicit/custom routes also need endpoint-scoped identity.
    const usesLegacyDefaultIdentity =
      providerId === "ollama" &&
      client.baseUrl === OLLAMA_DEFAULT_BASE_URL &&
      headersHash === undefined;
    const legacyCacheKeyData = {
      provider: providerId,
      ...(usesLegacyDefaultIdentity ? {} : { baseUrl: client.baseUrl }),
      model: client.model,
      outputDimensionality: client.outputDimensionality,
      ...(headersHash ? { headersHash } : {}),
    };
    return {
      provider,
      runtime: {
        id: "ollama",
        inlineBatchTimeoutMs: 10 * 60_000,
        cacheKeyData: {
          ...legacyCacheKeyData,
          ...(modelDigest ? { modelDigest } : {}),
        },
        ...(modelDigest
          ? { indexIdentityAliases: [{ model: client.model, cacheKeyData: legacyCacheKeyData }] }
          : {}),
      },
    };
  },
};
