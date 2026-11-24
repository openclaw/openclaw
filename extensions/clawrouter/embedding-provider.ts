import type {
  EmbeddingInput,
  EmbeddingProviderAdapter,
  EmbeddingProviderCallOptions,
  EmbeddingProviderCreateOptions,
} from "openclaw/plugin-sdk/embedding-providers";
import {
  createRemoteEmbeddingProvider,
  embeddingProviderOwnsDestination,
  resolveRemoteEmbeddingClient,
  sanitizeEmbeddingCacheHeaders,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { fetchWithRuntimeDispatcherOrMockedGlobal } from "openclaw/plugin-sdk/runtime-fetch";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import { mergeSsrFPolicies } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeClawRouterApiBaseUrl } from "./base-url.js";
import {
  fetchClawRouterCapabilityOffers,
  resolveClawRouterCapabilityHttpContext,
} from "./capability-offers.js";

const normalizeModel = (options: EmbeddingProviderCreateOptions) =>
  options.model.trim().replace(/^clawrouter\//u, "");

function indexIdentity(options: EmbeddingProviderCreateOptions) {
  const configured = options.config.models?.providers?.clawrouter;
  const providerBaseUrl = normalizeClawRouterApiBaseUrl(configured?.baseUrl);
  const baseUrl = normalizeClawRouterApiBaseUrl(options.remote?.baseUrl ?? configured?.baseUrl);
  const headers = {
    ...(embeddingProviderOwnsDestination({ baseUrl, providerBaseUrl })
      ? Object.fromEntries(
          Object.entries(configured?.headers ?? {}).flatMap(([name, value]) => {
            const header = normalizeResolvedSecretInputString({
              value,
              path: `models.providers.clawrouter.headers.${name}`,
            });
            return header === undefined ? [] : [[name, header]];
          }),
        )
      : {}),
    ...options.remote?.headers,
  };
  return {
    model: normalizeModel(options),
    cacheKeyData: {
      provider: "clawrouter",
      model: normalizeModel(options),
      baseUrl,
      headers: sanitizeEmbeddingCacheHeaders(headers, [
        "authorization",
        "content-type",
        "x-api-key",
        "api-key",
      ]),
    },
  };
}

export const clawrouterEmbeddingProvider: EmbeddingProviderAdapter = {
  id: "clawrouter",
  transport: "remote",
  authProviderId: "clawrouter",
  normalizeModel,
  resolveIndexIdentity: indexIdentity,
  create: async (options) => {
    const model = normalizeModel(options);
    if (!model) {
      throw new Error("Choose an embedding model from the ClawRouter catalog");
    }
    if (
      options.dimensions !== undefined ||
      options.taskType ||
      options.inputType ||
      options.queryInputType ||
      options.documentInputType
    ) {
      throw new Error("ClawRouter embeddings currently support the declared default text format");
    }
    const embedBatch = async (inputs: EmbeddingInput[], call?: EmbeddingProviderCallOptions) => {
      call?.signal?.throwIfAborted();
      if (!inputs.length) {
        return [];
      }
      if (inputs.some((input) => typeof input !== "string" && input.parts?.length)) {
        throw new Error("ClawRouter embeddings currently accept text-only inputs");
      }
      const signal = AbortSignal.any([
        AbortSignal.timeout(30_000),
        ...(call?.signal ? [call.signal] : []),
      ]);
      // The memory transport owns cross-origin credential admission, including remote overrides.
      const client = await resolveRemoteEmbeddingClient({
        provider: "clawrouter",
        options,
        defaultBaseUrl: normalizeClawRouterApiBaseUrl(undefined),
        normalizeModel: () => model,
      });
      const headers = new Headers(client.headers);
      if (client.resolveRequestHeaders) {
        const current = await client.resolveRequestHeaders({ forceRefresh: false, signal });
        for (const [name, value] of Object.entries(current)) {
          headers.set(name, value);
        }
      }
      const key = /^Bearer (.+)$/u.exec(headers.get("Authorization") ?? "")?.[1];
      if (!key) {
        throw new Error("ClawRouter embeddings require a router bearer credential");
      }
      signal.throwIfAborted();
      const cfg = options.config;
      const configured = cfg.models?.providers?.clawrouter;
      const context = resolveClawRouterCapabilityHttpContext(
        {
          ...cfg,
          models: {
            ...cfg.models,
            providers: {
              ...cfg.models?.providers,
              clawrouter: {
                ...configured,
                baseUrl: client.baseUrl,
                models: configured?.models ?? [],
                headers: Object.fromEntries(headers),
              },
            },
          },
        },
        key,
      );
      const offers = await fetchClawRouterCapabilityOffers({
        context,
        timeoutMs: () => 5_000,
        signal,
        ssrfPolicy: client.ssrfPolicy,
      });
      const offer = offers.find(
        (candidate) =>
          candidate.model?.id === model &&
          candidate.requestFormat === "openai.embeddings" &&
          candidate.responseFormat === "openai.embeddings" &&
          candidate.methods.includes("POST") &&
          candidate.url.endsWith("/embeddings") &&
          Array.isArray(candidate.model.capabilities) &&
          candidate.model.capabilities.includes("llm.embeddings"),
      );
      const wireModel =
        offer?.routeKind === "unified" ? model : normalizeOptionalString(offer?.model?.upstream);
      if (!offer || !wireModel) {
        throw new Error("ClawRouter has no eligible OpenAI-format embedding offer for this model");
      }
      signal.throwIfAborted();
      const provider = createRemoteEmbeddingProvider({
        id: "clawrouter",
        client: {
          baseUrl: offer.url.slice(0, -"/embeddings".length),
          headers: Object.fromEntries(context.headers),
          ssrfPolicy: mergeSsrFPolicies(client.ssrfPolicy, context.ssrfPolicy),
          model: wireModel,
          fetchImpl:
            offer.routeKind === "manifest"
              ? async (input, init) => {
                  if (typeof init?.body !== "string") {
                    throw new Error("ClawRouter manifest embeddings require a JSON request body");
                  }
                  return (client.fetchImpl ?? fetchWithRuntimeDispatcherOrMockedGlobal)(input, {
                    ...init,
                    body: JSON.stringify({ body: JSON.parse(init.body) }),
                  });
                }
              : client.fetchImpl,
        },
        batchQueryInputs: true,
        errorPrefix: "ClawRouter embeddings failed",
      });
      // One credential scope supplies both discovery and dispatch; no refresh fallback after admission.
      return provider.embedBatch(inputs, { ...call, signal });
    };
    return {
      provider: {
        id: "clawrouter",
        model,
        embedBatch,
        embed: async (input, call) => (await embedBatch([input], call))[0] ?? [],
      },
      runtime: { id: "clawrouter", cacheKeyData: indexIdentity(options).cacheKeyData },
    };
  },
};
