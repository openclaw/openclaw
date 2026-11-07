import { voyageEmbeddingRequestFields } from "openclaw/plugin-sdk/embedding-native-runtime";
import type {
  EmbeddingInput,
  EmbeddingProviderCallOptions,
  EmbeddingProviderCreateOptions,
} from "openclaw/plugin-sdk/embedding-providers";
import {
  createRemoteEmbeddingProvider,
  embeddingProviderOwnsDestination,
  resolveRemoteEmbeddingClient,
  sanitizeEmbeddingCacheHeaders,
  type MemoryEmbeddingProviderAdapter,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  fetchWithTimeoutGuarded,
  readProviderJsonObjectResponse,
} from "openclaw/plugin-sdk/provider-http";
import { fetchWithRuntimeDispatcherOrMockedGlobal } from "openclaw/plugin-sdk/runtime-fetch";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import { mergeSsrFPolicies } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeClawRouterApiBaseUrl } from "./base-url.js";
import {
  fetchClawRouterCapabilityOffers,
  resolveClawRouterCapabilityHttpContext,
} from "./capability-offers.js";
import { embeddingRole, prepareNativeEmbeddingRequests } from "./embedding-native.js";

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
      ...(options.dimensions === undefined ? {} : { dimensions: options.dimensions }),
      ...(options.taskType ? { taskType: options.taskType } : {}),
      ...(options.inputType ? { inputType: options.inputType } : {}),
      ...(options.queryInputType ? { queryInputType: options.queryInputType } : {}),
      ...(options.documentInputType ? { documentInputType: options.documentInputType } : {}),
      headers: sanitizeEmbeddingCacheHeaders(headers, [
        "authorization",
        "content-type",
        "x-api-key",
        "api-key",
      ]),
    },
  };
}

export const clawrouterEmbeddingProvider: MemoryEmbeddingProviderAdapter = {
  id: "clawrouter",
  transport: "remote",
  authProviderId: "clawrouter",
  normalizeModel,
  // Codec support only; each effect still requires a current qualified catalog offer.
  supportsMultimodalEmbeddings: ({ model }) =>
    /^(?:clawrouter\/)?(?:google|google-gemini|gemini)\/gemini-embedding-2(?:-preview)?$/u.test(
      model.trim(),
    ),
  resolveIndexIdentity: indexIdentity,
  create: async (options) => {
    const model = normalizeModel(options);
    if (!model) {
      throw new Error("Choose an embedding model from the ClawRouter catalog");
    }
    const embedBatch = async (inputs: EmbeddingInput[], call?: EmbeddingProviderCallOptions) => {
      call?.signal?.throwIfAborted();
      if (!inputs.length) {
        return [];
      }
      const expiresAt = Date.now() + 30_000;
      const timeoutMs = () => {
        const remaining = expiresAt - Date.now();
        if (remaining <= 0) {
          throw new Error("ClawRouter embedding deadline exceeded");
        }
        return remaining;
      };
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
        timeoutMs,
        signal,
        ssrfPolicy: client.ssrfPolicy,
      });
      const offer = offers.find(
        (candidate) =>
          candidate.model?.id === model &&
          ["openai.embeddings", "voyage.embeddings"].includes(candidate.requestFormat) &&
          candidate.responseFormat === candidate.requestFormat &&
          candidate.methods.includes("POST") &&
          candidate.url.endsWith("/embeddings") &&
          Array.isArray(candidate.model.capabilities) &&
          candidate.model.capabilities.includes("llm.embeddings"),
      );
      if (!offer) {
        const requests = prepareNativeEmbeddingRequests(offers, model, inputs, options, call);
        const vectors: number[][] = [];
        for (const request of requests) {
          signal.throwIfAborted();
          const { response, release } = await fetchWithTimeoutGuarded(
            request.offer.url,
            {
              method: "POST",
              headers: {
                ...Object.fromEntries(context.headers),
                "Content-Type": "application/json",
              },
              body: JSON.stringify(
                request.offer.routeKind === "manifest"
                  ? {
                      body: request.body,
                      ...(request.pathParams && { pathParams: request.pathParams }),
                    }
                  : request.body,
              ),
              signal,
            },
            timeoutMs(),
            client.fetchImpl ?? fetch,
            {
              ssrfPolicy: mergeSsrFPolicies(
                client.ssrfPolicy,
                context.ssrfPolicy,
                context.allowPrivateNetwork ? { allowPrivateNetwork: true } : undefined,
              ),
              dispatcherPolicy: context.dispatcherPolicy,
              auditContext: "clawrouter.native-embeddings",
            },
          );
          try {
            if (!response.ok) {
              throw new Error(`ClawRouter embeddings failed (HTTP ${response.status})`);
            }
            const payload = await readProviderJsonObjectResponse(
              response,
              "clawrouter.native-embeddings",
              {
                maxBytes: request.maxResponseBytes,
                timeoutMs,
              },
            );
            timeoutMs();
            signal.throwIfAborted();
            vectors.push(...request.read(payload));
            call?.onUsage?.(request.usage(payload));
          } finally {
            void response.body?.cancel().catch(() => undefined);
            await release();
          }
        }
        return vectors;
      }
      const role = embeddingRole(options, call);
      if (inputs.some((input) => typeof input !== "string" && input.parts?.length)) {
        throw new Error("This ClawRouter embedding offer accepts text-only inputs");
      }
      const voyage = offer.requestFormat === "voyage.embeddings";
      if (options.taskType || (!voyage && options.dimensions !== undefined)) {
        throw new Error("This ClawRouter embedding offer does not support the requested options");
      }
      if (
        voyage &&
        (!["voyage-4", "voyage-4-large", "voyage-4-lite"].includes(String(offer.model?.upstream)) ||
          (options.dimensions !== undefined &&
            ![256, 512, 1024, 2048].includes(options.dimensions)))
      ) {
        throw new Error("Unsupported Voyage embedding model or dimensions");
      }
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
        ...(voyage
          ? {
              buildRequestFields: (kind: "query" | "document") =>
                voyageEmbeddingRequestFields(kind, options.dimensions),
            }
          : {}),
        errorPrefix: "ClawRouter embeddings failed",
      });
      // One credential scope supplies both discovery and dispatch; no refresh fallback after admission.
      const vectors = await provider.embedBatch(inputs, { ...call, signal, inputType: role });
      if (voyage && vectors.some((row) => row.length !== (options.dimensions ?? 1024))) {
        throw new Error("Voyage embedding dimensions do not match the admitted request");
      }
      signal.throwIfAborted();
      timeoutMs();
      return vectors;
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
