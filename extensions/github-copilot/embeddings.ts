import {
  buildRemoteBaseUrlPolicy,
  sanitizeAndNormalizeEmbedding,
  withRemoteHttpResponse,
  type MemoryEmbeddingProvider,
  type MemoryEmbeddingProviderAdapter,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  readProviderJsonResponse,
  readResponseTextLimited,
  redactProviderResponseErrorText,
} from "openclaw/plugin-sdk/provider-http";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  asOptionalObjectRecord,
  filterStringEntries,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveFirstGithubToken } from "./auth.js";
import { resolveGithubCopilotDomain } from "./domain.js";
import { COPILOT_MODELS_LIST_DEFAULT_TIMEOUT_MS } from "./models.js";
import { resolveCopilotRuntimeAuth } from "./runtime-auth.js";
import { buildCopilotRuntimeHeaders } from "./runtime-identity.js";

const COPILOT_EMBEDDING_PROVIDER_ID = "github-copilot";

const PREFERRED_MODELS = [
  "text-embedding-3-small",
  "text-embedding-3-large",
  "text-embedding-ada-002",
] as const;

const COPILOT_ERROR_BODY_LIMIT_BYTES = 8 * 1024;
const COPILOT_EMBEDDINGS_RESPONSE_MAX_BYTES = 64 * 1024 * 1024;

type CopilotModelEntry = {
  id?: unknown;
  supported_endpoints?: unknown;
};

function normalizeCopilotEmbeddingModel(model: string): string {
  const normalized = model.trim();
  const prefix = `${COPILOT_EMBEDDING_PROVIDER_ID}/`;
  const stripped = normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
  // Keep invalid selections explicit and normalization idempotent across
  // cold memory options and direct provider creation.
  return stripped && stripped === stripped.trim() && !stripped.startsWith(prefix)
    ? stripped
    : normalized;
}

function pickBestModel(available: string[], userModel?: string): string {
  if (userModel) {
    const normalized = normalizeCopilotEmbeddingModel(userModel);
    if (available.length === 0) {
      throw new Error("No embedding models available from GitHub Copilot");
    }
    if (!available.includes(normalized)) {
      throw new Error(
        `GitHub Copilot embedding model "${normalized}" is not available. Available: ${available.join(", ")}`,
      );
    }
    return normalized;
  }
  const firstAvailable =
    PREFERRED_MODELS.find((preferred) => available.includes(preferred)) ?? available[0];
  if (firstAvailable) {
    return firstAvailable;
  }
  throw new Error("No embedding models available from GitHub Copilot");
}

function parseGitHubCopilotEmbeddingPayload(payload: unknown, expectedCount: number): number[][] {
  const data = asOptionalObjectRecord(payload)?.data;
  if (!Array.isArray(data)) {
    throw new Error("GitHub Copilot embeddings response missing data[]");
  }

  const vectors = Array.from<number[] | undefined>({ length: expectedCount });
  for (const entry of data) {
    const record = asOptionalObjectRecord(entry);
    if (!record) {
      throw new Error("GitHub Copilot embeddings response contains an invalid entry");
    }
    const { index: indexValue, embedding } = record;
    const index = typeof indexValue === "number" ? indexValue : Number.NaN;
    if (!Number.isInteger(index)) {
      throw new Error("GitHub Copilot embeddings response contains an invalid index");
    }
    if (index < 0 || index >= expectedCount) {
      throw new Error("GitHub Copilot embeddings response contains an out-of-range index");
    }
    if (vectors[index] !== undefined) {
      throw new Error("GitHub Copilot embeddings response contains duplicate indexes");
    }
    if (!Array.isArray(embedding) || !embedding.every((value) => typeof value === "number")) {
      throw new Error("GitHub Copilot embeddings response contains an invalid embedding");
    }
    vectors[index] = sanitizeAndNormalizeEmbedding(embedding);
  }

  for (let index = 0; index < expectedCount; index += 1) {
    if (vectors[index] === undefined) {
      throw new Error("GitHub Copilot embeddings response missing vectors for some inputs");
    }
  }
  return vectors as number[][];
}

export const githubCopilotMemoryEmbeddingProviderAdapter: MemoryEmbeddingProviderAdapter = {
  id: COPILOT_EMBEDDING_PROVIDER_ID,
  transport: "remote",
  authProviderId: COPILOT_EMBEDDING_PROVIDER_ID,
  normalizeModel: ({ model }) => normalizeCopilotEmbeddingModel(model),
  autoSelectPriority: 15,
  create: async (options) => {
    const explicitValue = normalizeResolvedSecretInputString({
      value: options.remote?.apiKey,
      path: "memory.search.remote.apiKey",
    });
    const customBaseUrl = options.remote?.baseUrl?.trim();
    const customRuntimeAuth = customBaseUrl
      ? (() => {
          if (!explicitValue) {
            throw new Error(
              "GitHub Copilot memory custom baseUrl requires an explicit memory.search.remote.apiKey",
            );
          }
          return { apiKey: explicitValue, baseUrl: customBaseUrl };
        })()
      : undefined;
    const profileAuth = explicitValue
      ? undefined
      : await resolveFirstGithubToken({
          agentDir: options.agentDir,
          config: options.config,
          env: process.env,
        });
    const value = explicitValue ?? profileAuth?.githubToken;
    if (!value) {
      throw new Error("No GitHub token available for Copilot embedding provider");
    }

    const githubDomain = resolveGithubCopilotDomain({
      env: process.env,
      explicit: profileAuth?.githubDomain,
      config: options.config,
    });
    // A custom endpoint owns its own explicit credential. Never resolve a
    // durable GitHub token and then forward it to an operator-supplied host.
    const runtimeAuth =
      customRuntimeAuth ??
      (await resolveCopilotRuntimeAuth({
        githubToken: value,
        env: process.env,
        githubDomain,
      }));
    const baseUrl = runtimeAuth.baseUrl;
    const ssrfPolicy = buildRemoteBaseUrlPolicy(baseUrl);
    const headers = buildCopilotRuntimeHeaders({
      config: options.config,
      headers: { "Content-Type": "application/json", ...options.remote?.headers },
    });

    // Always discover models even when the user pins one: this validates
    // the Copilot token and confirms the plan supports embeddings before
    // we attempt any embedding requests.
    const copilotToken = runtimeAuth.apiKey;
    const discoverEmbeddingModels = async (): Promise<string[]> => {
      const url = `${baseUrl.replace(/\/$/, "")}/models`;
      const discoveryHeaders = { ...headers, Authorization: `Bearer ${copilotToken}` };
      const { response, release } = await fetchWithSsrFGuard({
        url,
        init: { method: "GET", headers: discoveryHeaders },
        policy: ssrfPolicy,
        timeoutMs: COPILOT_MODELS_LIST_DEFAULT_TIMEOUT_MS,
        auditContext: "memory-remote",
      });
      try {
        if (!response.ok) {
          // Copilot requests carry a bearer token, so reflected upstream text must
          // be sanitized independently of the operator's log-redaction setting.
          const detail = redactProviderResponseErrorText(
            await readResponseTextLimited(response, COPILOT_ERROR_BODY_LIMIT_BYTES),
            discoveryHeaders,
          );
          throw new Error(`GitHub Copilot model discovery HTTP ${response.status}: ${detail}`);
        }
        const payload = await readProviderJsonResponse(response, "github-copilot.model-discovery");
        const allModels = Array.isArray((payload as { data?: unknown })?.data)
          ? ((payload as { data: CopilotModelEntry[] }).data ?? [])
          : [];
        // Filter for embedding models. The Copilot API may list embedding models
        // with an explicit /v1/embeddings endpoint, or with an empty
        // supported_endpoints array. Match both: endpoint-declared embedding
        // models and models whose ID indicates embedding capability.
        return allModels.flatMap((entry) => {
          const id = typeof entry.id === "string" ? entry.id.trim() : "";
          if (!id) {
            return [];
          }
          const endpoints = filterStringEntries(entry.supported_endpoints);
          return endpoints.some((ep) => ep.includes("embeddings")) || /\bembedding/i.test(id)
            ? [id]
            : [];
        });
      } finally {
        await release();
      }
    };
    const availableModels = await discoverEmbeddingModels();

    const userModel = options.model?.trim() || undefined;
    const model = pickBestModel(availableModels, userModel);

    const fetchImpl = fetch;
    const providerHeaders = { ...headers, Authorization: `Bearer ${runtimeAuth.apiKey}` };
    const embedMany = async (input: string[], signal?: AbortSignal): Promise<number[][]> => {
      if (input.length === 0) {
        return [];
      }

      const url = `${baseUrl.replace(/\/$/, "")}/embeddings`;
      return await withRemoteHttpResponse({
        url,
        fetchImpl,
        ssrfPolicy,
        signal,
        init: {
          method: "POST",
          headers: providerHeaders,
          body: JSON.stringify({ model, input }),
        },
        onResponse: async (response) => {
          if (!response.ok) {
            const detail = redactProviderResponseErrorText(
              await readResponseTextLimited(response, COPILOT_ERROR_BODY_LIMIT_BYTES),
              providerHeaders,
            );
            throw new Error(`GitHub Copilot embeddings HTTP ${response.status}: ${detail}`);
          }
          const payload = await readProviderJsonResponse(response, "github-copilot.embeddings", {
            maxBytes: COPILOT_EMBEDDINGS_RESPONSE_MAX_BYTES,
          });
          return parseGitHubCopilotEmbeddingPayload(payload, input.length);
        },
      });
    };
    const provider: MemoryEmbeddingProvider = {
      id: COPILOT_EMBEDDING_PROVIDER_ID,
      model,
      embed: async (input, callOptions) => {
        const [vector] = await embedMany(
          [typeof input === "string" ? input : input.text],
          callOptions?.signal,
        );
        return vector ?? [];
      },
      embedBatch: async (inputs, callOptions) => {
        const texts = inputs.map((input) => (typeof input === "string" ? input : input.text));
        if (callOptions?.inputType === "query") {
          return await Promise.all(
            texts.map(async (text) => (await embedMany([text], callOptions.signal))[0] ?? []),
          );
        }
        return await embedMany(texts, callOptions?.signal);
      },
    };

    return {
      provider,
      runtime: {
        id: COPILOT_EMBEDDING_PROVIDER_ID,
        cacheKeyData: {
          provider: COPILOT_EMBEDDING_PROVIDER_ID,
          baseUrl,
          model,
        },
      },
    };
  },
};
