import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import {
  isKnownEnvApiKeyMarker,
  isNonSecretApiKeyMarker,
  normalizeOptionalSecretInput,
} from "openclaw/plugin-sdk/provider-auth";
import { resolveEnvApiKey } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
} from "openclaw/plugin-sdk/secret-input";
import {
  fetchWithSsrFGuard,
  formatErrorMessage,
  type SsrFPolicy,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { OLLAMA_CLOUD_BASE_URL } from "./defaults.js";
import { resolveOllamaApiBase } from "./provider-models.js";

export type OllamaEmbeddingProvider = {
  id: string;
  model: string;
  maxInputTokens?: number;
  embedQuery: (text: string) => Promise<number[]>;
  embedBatch: (texts: string[]) => Promise<number[][]>;
};

type OllamaEmbeddingOptions = {
  config: OpenClawConfig;
  agentDir?: string;
  provider?: string;
  remote?: {
    baseUrl?: string;
    apiKey?: unknown;
    headers?: Record<string, string>;
  };
  model: string;
  fallback?: string;
  local?: unknown;
  outputDimensionality?: number;
  taskType?: unknown;
};

export type OllamaEmbeddingClient = {
  baseUrl: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  model: string;
  embedBatch: (texts: string[]) => Promise<number[][]>;
};

type OllamaEmbeddingClientConfig = Omit<OllamaEmbeddingClient, "embedBatch">;

export const DEFAULT_OLLAMA_EMBEDDING_MODEL = "nomic-embed-text";

function sanitizeAndNormalizeEmbedding(vec: number[]): number[] {
  const sanitized = vec.map((value) => (Number.isFinite(value) ? value : 0));
  const magnitude = Math.sqrt(sanitized.reduce((sum, value) => sum + value * value, 0));
  if (magnitude < 1e-10) {
    return sanitized;
  }
  return sanitized.map((value) => value / magnitude);
}

function buildRemoteBaseUrlPolicy(baseUrl: string): SsrFPolicy | undefined {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return { allowedHostnames: [parsed.hostname] };
  } catch {
    return undefined;
  }
}

async function withRemoteHttpResponse<T>(params: {
  url: string;
  init?: RequestInit;
  ssrfPolicy?: SsrFPolicy;
  onResponse: (response: Response) => Promise<T>;
}): Promise<T> {
  const { response, release } = await fetchWithSsrFGuard({
    url: params.url,
    init: params.init,
    policy: params.ssrfPolicy,
    auditContext: "memory-remote",
  });
  try {
    return await params.onResponse(response);
  } finally {
    await release();
  }
}

function normalizeEmbeddingModel(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) {
    return DEFAULT_OLLAMA_EMBEDDING_MODEL;
  }
  return trimmed.startsWith("ollama/") ? trimmed.slice("ollama/".length) : trimmed;
}

function resolveMemorySecretInputString(params: {
  value: unknown;
  path: string;
}): string | undefined {
  if (!hasConfiguredSecretInput(params.value)) {
    return undefined;
  }
  return normalizeResolvedSecretInputString({
    value: params.value,
    path: params.path,
  });
}

type OllamaEmbeddingAuthSource = "remote-config" | "provider-config" | "env" | "none";

type OllamaEmbeddingAuthResolution = {
  apiKey: string | undefined;
  source: OllamaEmbeddingAuthSource;
};

type OllamaEmbeddingBaseUrlOrigin = "remote-config" | "provider-config" | "default";

type OllamaEmbeddingBaseUrlResolution = {
  baseUrl: string;
  origin: OllamaEmbeddingBaseUrlOrigin;
};

// Per-source resolution state. `unset` means the user did not declare this
// source. `opt-out` means the user declared it but it resolves to "no
// usable auth" (e.g., the `ollama-local` placeholder) — downstream code
// must honor the opt-out within that source's scope. A plain object means
// a usable bearer string was produced.
type OllamaEmbeddingSourceResolution = "unset" | "opt-out" | { apiKey: string };

type OllamaEmbeddingResolvedKeys = {
  remote: OllamaEmbeddingSourceResolution;
  provider: OllamaEmbeddingSourceResolution;
  env: string | undefined;
};

function resolveSourcedOllamaEmbeddingKey(params: {
  configString: string | undefined;
  declared: boolean;
}): OllamaEmbeddingSourceResolution {
  const { configString, declared } = params;
  if (configString !== undefined) {
    if (!isNonSecretApiKeyMarker(configString)) {
      return { apiKey: configString };
    }
    // Only env-var-name markers (e.g., `"OLLAMA_API_KEY"`) opt into
    // env-backed resolution: they explicitly mean "this source's apiKey is
    // whatever env OLLAMA_API_KEY resolves to." Host-backed placeholders
    // such as `"ollama-local"` or `"custom-local"` mean the user declared
    // "no real auth needed for my local host" — swapping those for a
    // cloud-scoped env value would leak the cloud key onto a local or
    // self-hosted Ollama, which is the leak this scoping is preventing.
    if (!isKnownEnvApiKeyMarker(configString)) {
      return "opt-out";
    }
    const envKey = resolveEnvApiKey("ollama")?.apiKey;
    if (envKey && !isNonSecretApiKeyMarker(envKey)) {
      return { apiKey: envKey };
    }
    return "opt-out";
  }
  // `configString` is undefined. If the user declared a `SecretRef` that
  // did not resolve to a string here (the public config type is
  // `SecretInput`, which covers string markers and SecretRef objects),
  // treat it the same as an explicit env marker: they linked env auth to
  // this source.
  if (declared) {
    const envKey = resolveEnvApiKey("ollama")?.apiKey;
    if (envKey && !isNonSecretApiKeyMarker(envKey)) {
      return { apiKey: envKey };
    }
    return "opt-out";
  }
  return "unset";
}

function resolveOllamaEmbeddingResolvedKeys(
  options: OllamaEmbeddingOptions,
): OllamaEmbeddingResolvedKeys {
  const remoteValue = options.remote?.apiKey;
  const remote = resolveSourcedOllamaEmbeddingKey({
    configString: resolveMemorySecretInputString({
      value: remoteValue,
      path: "agents.*.memorySearch.remote.apiKey",
    }),
    declared: hasConfiguredSecretInput(remoteValue),
  });
  const providerValue = options.config.models?.providers?.ollama?.apiKey;
  const provider = resolveSourcedOllamaEmbeddingKey({
    configString: normalizeOptionalSecretInput(providerValue),
    declared: hasConfiguredSecretInput(providerValue),
  });
  const envKeyRaw = resolveEnvApiKey("ollama")?.apiKey;
  const env = envKeyRaw && !isNonSecretApiKeyMarker(envKeyRaw) ? envKeyRaw : undefined;
  return { remote, provider, env };
}

function selectOllamaEmbeddingAuth(params: {
  resolved: OllamaEmbeddingResolvedKeys;
  baseUrl: string;
  baseUrlOrigin: OllamaEmbeddingBaseUrlOrigin;
  providerOwnedHost: string;
}): OllamaEmbeddingAuthResolution {
  const { resolved, baseUrl, baseUrlOrigin, providerOwnedHost } = params;
  // 1. `remote.apiKey` is the outermost declaration for memory-search
  //    embedding auth. If the user declared it, that declaration is final
  //    for this call — including an explicit opt-out via placeholder.
  if (resolved.remote !== "unset") {
    if (typeof resolved.remote === "object") {
      return { apiKey: resolved.remote.apiKey, source: "remote-config" };
    }
    return { apiKey: undefined, source: "none" };
  }
  // 2. `models.providers.ollama.apiKey` applies only when the embedding
  //    call is reaching the provider's own host — either because the
  //    resolved base URL came from the provider config (or the default
  //    when no provider baseUrl was set), or because a remote override
  //    redundantly named the provider's host.
  if (resolved.provider !== "unset" && typeof resolved.provider === "object") {
    const reachesProviderHost =
      baseUrlOrigin === "provider-config" ||
      baseUrlOrigin === "default" ||
      areOllamaHostsEquivalent(baseUrl, providerOwnedHost);
    if (reachesProviderHost) {
      return { apiKey: resolved.provider.apiKey, source: "provider-config" };
    }
  }
  // 3. Env OLLAMA_API_KEY is the Ollama Cloud convention. It is only
  //    attached when the resolved base URL is Ollama Cloud itself, and
  //    only when no more-specific provider key already covered the call.
  if (resolved.env && isOllamaCloudBaseUrl(baseUrl)) {
    return { apiKey: resolved.env, source: "env" };
  }
  return { apiKey: undefined, source: "none" };
}

function resolveOllamaEmbeddingAuth(
  options: OllamaEmbeddingOptions,
): OllamaEmbeddingAuthResolution {
  // Preserved for its existing test surface. `selectOllamaEmbeddingAuth`
  // is the real decision — it factors in the resolved base URL — but this
  // function answers "what did the user declare?" without committing to a
  // target, which is what the `__testing` helpers inspect.
  const resolved = resolveOllamaEmbeddingResolvedKeys(options);
  if (typeof resolved.remote === "object") {
    return { apiKey: resolved.remote.apiKey, source: "remote-config" };
  }
  if (typeof resolved.provider === "object") {
    return { apiKey: resolved.provider.apiKey, source: "provider-config" };
  }
  if (resolved.env !== undefined) {
    return { apiKey: resolved.env, source: "env" };
  }
  return { apiKey: undefined, source: "none" };
}

function resolveOllamaEmbeddingBaseUrl(
  options: OllamaEmbeddingOptions,
): OllamaEmbeddingBaseUrlResolution {
  const remote = options.remote?.baseUrl?.trim();
  if (remote) {
    return { baseUrl: resolveOllamaApiBase(remote), origin: "remote-config" };
  }
  const provider = options.config.models?.providers?.ollama?.baseUrl?.trim();
  if (provider) {
    return { baseUrl: resolveOllamaApiBase(provider), origin: "provider-config" };
  }
  return { baseUrl: resolveOllamaApiBase(undefined), origin: "default" };
}

function normalizeOllamaHostKey(baseUrl: string): string | undefined {
  // Produce a canonical "proto://host:port/path" key so equivalent URLs
  // compare equal regardless of case, default-port presence, or the
  // `localhost` alias, while still distinguishing reverse-proxy path
  // prefixes (for example `https://proxy.example.com/team-a` vs
  // `.../team-b`) that route to different tenants on the same host.
  // Hostnames are case-insensitive per RFC 3986, default ports (80/443)
  // are unspecified forms of the same endpoint, and `localhost` resolves
  // to the loopback target that `127.0.0.1` also names.
  try {
    const parsed = new URL(baseUrl);
    let hostname = parsed.hostname.toLowerCase();
    // Alias the loopback names that routinely point at the same local
    // Ollama server: `localhost`, the IPv4 literal `127.0.0.1`, and the
    // IPv6 literal `::1` (with or without brackets, since Node's URL
    // parser has historically returned both forms).
    if (hostname === "localhost" || hostname === "::1" || hostname === "[::1]") {
      hostname = "127.0.0.1";
    }
    const port = parsed.port !== "" ? parsed.port : parsed.protocol === "https:" ? "443" : "80";
    const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "");
    return `${parsed.protocol}//${hostname}:${port}${path}`;
  } catch {
    return undefined;
  }
}

function areOllamaHostsEquivalent(a: string, b: string): boolean {
  const aKey = normalizeOllamaHostKey(a);
  const bKey = normalizeOllamaHostKey(b);
  return aKey !== undefined && bKey !== undefined && aKey === bKey;
}

function isOllamaCloudBaseUrl(baseUrl: string): boolean {
  // `areOllamaHostsEquivalent` already compares path prefixes, so a
  // non-root `https://ollama.com/some/path` does not satisfy this check.
  return areOllamaHostsEquivalent(baseUrl, OLLAMA_CLOUD_BASE_URL);
}

function resolveProviderOwnedHost(options: OllamaEmbeddingOptions): string {
  const raw = options.config.models?.providers?.ollama?.baseUrl?.trim();
  return raw ? resolveOllamaApiBase(raw) : resolveOllamaApiBase(undefined);
}

function resolveOllamaEmbeddingClient(
  options: OllamaEmbeddingOptions,
): OllamaEmbeddingClientConfig {
  const providerConfig = options.config.models?.providers?.ollama;
  const { baseUrl, origin: baseUrlOrigin } = resolveOllamaEmbeddingBaseUrl(options);
  const model = normalizeEmbeddingModel(options.model);
  const headerOverrides = Object.assign({}, providerConfig?.headers, options.remote?.headers);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...headerOverrides,
  };
  const resolved = resolveOllamaEmbeddingResolvedKeys(options);
  const providerOwnedHost = resolveProviderOwnedHost(options);
  const auth = selectOllamaEmbeddingAuth({
    resolved,
    baseUrl,
    baseUrlOrigin,
    providerOwnedHost,
  });
  if (auth.apiKey) {
    headers.Authorization = `Bearer ${auth.apiKey}`;
  }
  return {
    baseUrl,
    headers,
    ssrfPolicy: buildRemoteBaseUrlPolicy(baseUrl),
    model,
  };
}

export const __testing = {
  areOllamaHostsEquivalent,
  isOllamaCloudBaseUrl,
  resolveOllamaEmbeddingAuth,
  resolveOllamaEmbeddingBaseUrl,
  resolveOllamaEmbeddingResolvedKeys,
  selectOllamaEmbeddingAuth,
};

export async function createOllamaEmbeddingProvider(
  options: OllamaEmbeddingOptions,
): Promise<{ provider: OllamaEmbeddingProvider; client: OllamaEmbeddingClient }> {
  const client = resolveOllamaEmbeddingClient(options);
  const embedUrl = `${client.baseUrl.replace(/\/$/, "")}/api/embeddings`;

  const embedOne = async (text: string): Promise<number[]> => {
    const json = await withRemoteHttpResponse({
      url: embedUrl,
      ssrfPolicy: client.ssrfPolicy,
      init: {
        method: "POST",
        headers: client.headers,
        body: JSON.stringify({ model: client.model, prompt: text }),
      },
      onResponse: async (response) => {
        if (!response.ok) {
          throw new Error(`Ollama embeddings HTTP ${response.status}: ${await response.text()}`);
        }
        return (await response.json()) as { embedding?: number[] };
      },
    });
    if (!Array.isArray(json.embedding)) {
      throw new Error("Ollama embeddings response missing embedding[]");
    }
    return sanitizeAndNormalizeEmbedding(json.embedding);
  };

  const provider: OllamaEmbeddingProvider = {
    id: "ollama",
    model: client.model,
    embedQuery: embedOne,
    embedBatch: async (texts) => {
      return await Promise.all(texts.map(embedOne));
    },
  };

  return {
    provider,
    client: {
      ...client,
      embedBatch: async (texts) => {
        try {
          return await provider.embedBatch(texts);
        } catch (err) {
          throw new Error(formatErrorMessage(err), { cause: err });
        }
      },
    },
  };
}
