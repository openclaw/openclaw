import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { EmbeddingProviderOptions } from "./embeddings.types.js";
import { requireApiKey, resolveApiKeyForProvider } from "./openclaw-runtime-auth.js";
import type { SsrFPolicy } from "./openclaw-runtime-network.js";
import { buildRemoteBaseUrlPolicy } from "./remote-http.js";
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

function normalizeEmbeddingDestinationKey(baseUrl: string): string | undefined {
  const parsed = URL.parse(baseUrl);
  if (!parsed) {
    return undefined;
  }
  const hostname = parsed.hostname.toLowerCase();
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  const pathname = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "");
  return `${parsed.protocol}//${hostname}:${port}${pathname}${parsed.search}`;
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

/** Detect the native OpenAI embeddings API route that accepts attribution headers. */
function isNativeOpenAIEmbeddingRoute(provider: string, baseUrl: string): boolean {
  return (
    provider === "openai" &&
    URL.parse(baseUrl)?.hostname.toLowerCase().replace(/\.+$/, "") === "api.openai.com"
  );
}

/**
 * The recognized native ChatGPT/Codex subscription route. It serves chat
 * traffic only — it has no embeddings endpoint, so its base URL must never
 * leak into embedding requests. (#165476)
 */
const NATIVE_CHAT_ONLY_SUBSCRIPTION_BASE_URL = "https://chatgpt.com/backend-api/codex";

/**
 * Whether the provider is pinned to the recognized native chat-only
 * subscription route. The redirect to the adapter default must apply ONLY
 * here: matching on the api mode alone would also redirect custom provider
 * URLs, misattributing their destination-owned credentials (e.g. a custom
 * Authorization header) to the adapter default such as api.openai.com.
 */
function isNativeChatOnlySubscriptionRoute(
  api: string | undefined,
  baseUrl: string | undefined,
): boolean {
  return (
    api === "openai-chatgpt-responses" &&
    normalizeEmbeddingDestinationKey(NATIVE_CHAT_ONLY_SUBSCRIPTION_BASE_URL) ===
      normalizeEmbeddingDestinationKey(baseUrl ?? "")
  );
}

/** Resolve base URL, bearer headers, header overrides, and SSRF policy for remote embeddings. */
export async function resolveRemoteEmbeddingBearerClient(params: {
  provider: RemoteEmbeddingProviderId;
  capability?: string;
  options: EmbeddingProviderOptions;
  defaultBaseUrl: string;
}): Promise<{ baseUrl: string; headers: Record<string, string>; ssrfPolicy?: SsrFPolicy }> {
  const remote = params.options.remote;
  const remoteApiKey = resolveMemorySecretInputString({
    value: remote?.apiKey,
    path: "memory.search.remote.apiKey",
  });
  const remoteBaseUrl = normalizeOptionalString(remote?.baseUrl);
  const providerConfig = params.options.config.models?.providers?.[params.provider];
  // A chat-only subscription route has no embeddings endpoint: never inherit
  // its base URL for embeddings — fall through to the adapter default instead.
  // The redirect applies ONLY to the recognized native subscription route; a
  // custom provider URL keeps its own destination (and credentials) even when
  // the provider uses a chat-only subscription api mode.
  const providerBaseUrl = isNativeChatOnlySubscriptionRoute(
    normalizeOptionalString(providerConfig?.api),
    normalizeOptionalString(providerConfig?.baseUrl),
  )
    ? params.defaultBaseUrl
    : normalizeOptionalString(providerConfig?.baseUrl) || params.defaultBaseUrl;
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
  const apiKey = hasExplicitAuthorization
    ? undefined
    : remoteApiKey
      ? remoteApiKey
      : providerOwnsDestination
        ? requireApiKey(
            await resolveApiKeyForProvider({
              provider: params.provider,
              capability: params.capability,
              modelBaseUrl: baseUrl,
              cfg: params.options.config,
              agentDir: params.options.agentDir,
            }),
            params.provider,
          )
        : undefined;
  if (!apiKey && !hasExplicitAuthorization) {
    throw new Error(
      `${params.provider} embedding credentials are not configured for ${baseUrl}. Set memory.search.remote.apiKey or an Authorization header for this destination.`,
    );
  }
  const entries: Array<[string, string]> = [["Content-Type", "application/json"]];
  if (apiKey) {
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
  return { baseUrl, headers, ssrfPolicy: buildRemoteBaseUrlPolicy(baseUrl) };
}
