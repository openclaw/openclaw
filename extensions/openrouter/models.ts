// Openrouter plugin module implements models behavior.
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

const OPENROUTER_MISTRAL_MODEL_PREFIXES = [
  "mistralai/",
  "mistral/",
  "mistral-",
  "codestral-",
  "devstral-",
  "ministral-",
  "mixtral-",
  "pixtral-",
  "voxtral-",
] as const;
const OPENROUTER_MODEL_PREFIX = "openrouter/";
// When OpenRouter adds new native routing identifiers they must be added here.
// Current set derived from the public OpenRouter /models endpoint.
// See #95198 and the provider-normalizer contract in openrouter/index.ts.
const OPENROUTER_NATIVE_ROUTE_IDS = new Set([
  "auto",
  "auto:free",
  "auto:lowest-latency",
  "bodybuilder",
  "free",
  "fusion",
  "owl-alpha",
  "pareto-code",
]);
const OPENROUTER_NATIVE_ROUTE_ID_PREFIXES = ["hunter-alpha"] as const;

function isOpenRouterNativeRouteId(unprefixed: string): boolean {
  if (OPENROUTER_NATIVE_ROUTE_IDS.has(unprefixed)) {
    return true;
  }
  return OPENROUTER_NATIVE_ROUTE_ID_PREFIXES.some(
    (prefix) => unprefixed === prefix || unprefixed.startsWith(`${prefix}:`),
  );
}

// Short convenience refs that must expand to their namespaced upstream slugs
// before the API call. Without this, `openrouter/deepseek-v4-flash` would be
// sent as-is and rejected with HTTP 400 model_not_found (#95198).
const OPENROUTER_SHORT_TO_UPSTREAM_SLUG = new Map<string, string>([
  ["deepseek-v4-flash", "deepseek/deepseek-v4-flash"],
  ["deepseek-v4-pro", "deepseek/deepseek-v4-pro"],
]);

export function normalizeOpenRouterModelId(modelId: unknown): string | undefined {
  if (typeof modelId !== "string") {
    return undefined;
  }
  const normalized = normalizeLowercaseStringOrEmpty(modelId);
  return normalized.startsWith(OPENROUTER_MODEL_PREFIX)
    ? normalized.slice(OPENROUTER_MODEL_PREFIX.length)
    : normalized;
}

export function normalizeOpenRouterApiModelId(modelId: unknown): string | undefined {
  if (typeof modelId !== "string") {
    return undefined;
  }
  const normalized = normalizeLowercaseStringOrEmpty(modelId);
  if (!normalized.startsWith(OPENROUTER_MODEL_PREFIX)) {
    return normalized;
  }
  const unprefixed = normalized.slice(OPENROUTER_MODEL_PREFIX.length);
  // `openrouter/` is both a provider qualifier and an upstream namespace.
  // Three cases after stripping the prefix:
  // 1. Known short ref (deepseek-v4-flash) → expand to namespaced upstream slug.
  // 2. Contains "/" (anthropic/claude-sonnet-4.6) → strip prefix, keep remainder.
  // 3. Everything else → preserve prefix (native OpenRouter route id or
  //    unrecognized ref; stripping could break future native ids, #95198).
  const upstreamSlug = OPENROUTER_SHORT_TO_UPSTREAM_SLUG.get(unprefixed);
  if (upstreamSlug) {
    return upstreamSlug;
  }
  if (unprefixed.includes("/")) {
    return unprefixed;
  }
  if (isOpenRouterNativeRouteId(unprefixed)) {
    return normalized;
  }
  return normalized;
}

export function isOpenRouterMistralModelId(modelId: unknown): boolean {
  const normalized = normalizeOpenRouterModelId(modelId);
  return Boolean(
    normalized && OPENROUTER_MISTRAL_MODEL_PREFIXES.some((prefix) => normalized.startsWith(prefix)),
  );
}

export function isOpenRouterDeepSeekV4ModelId(modelId: unknown): boolean {
  const normalized = normalizeOpenRouterModelId(modelId);
  if (!normalized?.startsWith("deepseek/")) {
    return false;
  }
  const deepSeekModelId = normalized.slice("deepseek/".length).split(":", 1)[0];
  return deepSeekModelId === "deepseek-v4-flash" || deepSeekModelId === "deepseek-v4-pro";
}
