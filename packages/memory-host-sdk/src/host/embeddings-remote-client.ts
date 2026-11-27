import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { EmbeddingProviderCreateOptions } from "../../../../src/plugins/embedding-provider-types.js";
import {
  isNativeOpenAIEmbeddingRoute,
  normalizeEmbeddingDestinationKey,
  resolveProviderEmbeddingBaseUrl,
} from "./embeddings-destination.js";
import { requireApiKey, resolveApiKeyForProvider } from "./openclaw-runtime-auth.js";
import {
  resolveProviderRequestPolicyConfig,
  resolveProviderTransportSsrFPolicy,
  type SsrFPolicy,
} from "./openclaw-runtime-network.js";
import type { RemoteEmbeddingRequestAuth } from "./remote-http.js";
import { resolveMemorySecretInputString } from "./secret-input.js";

// Builds authenticated remote embedding HTTP clients from agent memory config.

/** Provider id used for remote embedding auth and config lookup. */
export type RemoteEmbeddingProviderId = string;

/** Attribution headers for native OpenAI embedding calls. */
function resolveOpenClawAttributionHeaders(): Record<string, string> {
  const version = typeof process !== "undefined" ? process.env.OPENCLAW_VERSION?.trim() : undefined;
  return {
    originator: "openclaw",
    ...(version ? { version } : {}),
    "User-Agent": version ? `openclaw/${version}` : "openclaw",
  };
}

/** Whether provider-owned embedding credentials belong to the selected destination. */
export function embeddingProviderOwnsDestination(params: {
  baseUrl: string;
  providerBaseUrl: string;
}): boolean {
  const baseUrlKey = normalizeEmbeddingDestinationKey(params.baseUrl);
  const providerBaseUrlKey = normalizeEmbeddingDestinationKey(params.providerBaseUrl);
  return baseUrlKey !== undefined && baseUrlKey === providerBaseUrlKey;
}

/** Append an embedding endpoint without changing its destination-owned query. */
export function resolveEmbeddingEndpointUrl(baseUrl: string, endpoint: string): string {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/${endpoint.replace(/^\/+/, "")}`;
  url.hash = "";
  return url.toString();
}

function resolveEmbeddingHeaders(
  ...sources: Array<{ headers: Record<string, unknown> | undefined; path: string }>
): Map<string, [string, string]> {
  const resolved = new Map<string, [string, string]>();
  for (const source of sources) {
    // Retain each source's existing SecretRef and prototype-key handling.
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(source.headers ?? {})) {
      const header = resolveMemorySecretInputString({ value, path: `${source.path}.${name}` });
      if (header) {
        headers[name] = header;
      }
    }
    for (const entry of Object.entries(headers)) {
      resolved.set(entry[0].toLowerCase(), entry);
    }
  }
  return resolved;
}

/** Resolve base URL, bearer headers, header overrides, and SSRF policy for remote embeddings. */
export async function resolveRemoteEmbeddingBearerClient(params: {
  provider: RemoteEmbeddingProviderId;
  capability?: string;
  options: EmbeddingProviderCreateOptions;
  defaultBaseUrl: string;
}): Promise<{
  baseUrl: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  resolveRequestHeaders?: RemoteEmbeddingRequestAuth;
}> {
  const remote = params.options.remote;
  const remoteApiKey = resolveMemorySecretInputString({
    value: remote?.apiKey,
    path: "memory.search.remote.apiKey",
  });
  const remoteBaseUrl = normalizeOptionalString(remote?.baseUrl);
  const providerConfig = params.options.config.models?.providers?.[params.provider];
  const providerBaseUrl = resolveProviderEmbeddingBaseUrl(providerConfig, params.defaultBaseUrl);
  const baseUrl = remoteBaseUrl || providerBaseUrl;
  const providerOwnsDestination = embeddingProviderOwnsDestination({
    baseUrl,
    providerBaseUrl,
  });
  const headerOverrides = resolveEmbeddingHeaders(
    {
      headers: providerOwnsDestination ? providerConfig?.headers : undefined,
      path: `models.providers.${params.provider}.headers`,
    },
    {
      headers: remote?.headers,
      path: "memory.search.remote.headers",
    },
  );
  const hasExplicitAuthorization = headerOverrides.has("authorization");
  const resolveAuth = (forceRefresh: boolean, signal?: AbortSignal) =>
    resolveApiKeyForProvider({
      provider: params.provider,
      capability: params.capability,
      modelBaseUrl: baseUrl,
      cfg: params.options.config,
      agentDir: params.options.agentDir,
      forceRefresh,
      signal,
    });
  const auth =
    !hasExplicitAuthorization && !remoteApiKey && providerOwnsDestination
      ? await resolveAuth(false)
      : undefined;
  const apiKey = hasExplicitAuthorization
    ? undefined
    : remoteApiKey || (auth ? requireApiKey(auth, params.provider) : undefined);
  if (!apiKey && !hasExplicitAuthorization) {
    throw new Error(
      `${params.provider} embedding credentials are not configured for ${baseUrl}. Set memory.search.remote.apiKey or an Authorization header for this destination.`,
    );
  }
  const entries: Array<[string, string]> = [["Content-Type", "application/json"]];
  if (apiKey && auth?.mode !== "oauth") {
    entries.push(["Authorization", `Bearer ${apiKey}`]);
  }
  entries.push(...headerOverrides.values());
  if (isNativeOpenAIEmbeddingRoute(params.provider, baseUrl)) {
    entries.push(...Object.entries(resolveOpenClawAttributionHeaders()));
  }
  // Fetch joins duplicate names; retain only the last source, but preserve its
  // spelling so ordinary non-secret embedding cache identities stay unchanged.
  const headers = Object.fromEntries(
    new Map(entries.map((entry) => [entry[0].toLowerCase(), entry])).values(),
  );
  const resolveRequestHeaders: RemoteEmbeddingRequestAuth | undefined =
    auth?.mode === "oauth"
      ? async ({ forceRefresh, signal }) => ({
          Authorization: `Bearer ${requireApiKey(await resolveAuth(forceRefresh, signal), params.provider)}`,
        })
      : undefined;
  return {
    baseUrl,
    headers,
    ...(resolveRequestHeaders ? { resolveRequestHeaders } : {}),
    ssrfPolicy: resolveEmbeddingProviderSsrFPolicy({
      provider: params.provider,
      api: providerConfig?.api ?? "openai-completions",
      baseUrl,
      allowPrivateNetwork: providerConfig?.request?.allowPrivateNetwork,
    }),
  };
}

/** Embedding adapters share inference's endpoint classification and explicit network policy. */
export function resolveEmbeddingProviderSsrFPolicy(params: {
  provider: string;
  api?: string;
  baseUrl: string;
  allowPrivateNetwork?: boolean;
}): SsrFPolicy | undefined {
  const policy = resolveProviderRequestPolicyConfig({
    provider: params.provider,
    api: params.api,
    baseUrl: params.baseUrl,
    capability: "other",
    request: { allowPrivateNetwork: params.allowPrivateNetwork },
  });
  return resolveProviderTransportSsrFPolicy({
    baseUrl: params.baseUrl,
    url: params.baseUrl,
    allowPrivateNetwork: policy.allowPrivateNetwork,
    trustConfiguredBaseUrlOrigin: policy.trustConfiguredBaseUrlOrigin,
  });
}
