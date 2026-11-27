import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

// Where a provider's own embedding requests go. Pure config logic, shared by the embedding
// client and the memory-search provider choice so both read one destination rule.

export function normalizeEmbeddingDestinationKey(baseUrl: string): string | undefined {
  const parsed = URL.parse(baseUrl);
  if (!parsed) {
    return undefined;
  }
  const hostname = parsed.hostname.toLowerCase();
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  const pathname = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "");
  return `${parsed.protocol}//${hostname}:${port}${pathname}${parsed.search}`;
}

/** Detect the native OpenAI embeddings API route that accepts attribution headers. */
export function isNativeOpenAIEmbeddingRoute(provider: string, baseUrl: string): boolean {
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

/**
 * The provider's embedding destination before `memory.search.remote`. A chat-only
 * subscription route has no embeddings endpoint, so it falls through to the adapter
 * default; any other provider URL, custom ones included, keeps its own destination.
 */
export function resolveProviderEmbeddingBaseUrl(
  providerConfig: { api?: string; baseUrl?: string } | undefined,
  defaultBaseUrl: string,
): string {
  const baseUrl = normalizeOptionalString(providerConfig?.baseUrl);
  return isNativeChatOnlySubscriptionRoute(normalizeOptionalString(providerConfig?.api), baseUrl)
    ? defaultBaseUrl
    : baseUrl || defaultBaseUrl;
}
