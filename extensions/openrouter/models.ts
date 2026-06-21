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

export function normalizeOpenRouterModelId(modelId: unknown): string | undefined {
  if (typeof modelId !== "string") {
    return undefined;
  }
  const normalized = normalizeLowercaseStringOrEmpty(modelId);
  return normalized.startsWith(OPENROUTER_MODEL_PREFIX)
    ? normalized.slice(OPENROUTER_MODEL_PREFIX.length)
    : normalized;
}

// Short model aliases that lack an upstream namespace prefix but still need
// to be expanded to the full OpenRouter API model id. Without this mapping,
// a model configured as "openrouter/deepseek-v4-flash" would lose its upstream
// namespace when the unprefixed remainder ("deepseek-v4-flash") contains no "/",
// and the original prefixed form would be returned — causing downstream code
// that re-adds the "openrouter/" prefix to produce "openrouter/openrouter/…".
const SHORT_MODEL_ALIASES = new Map<string, string>([
  ["deepseek-v4-flash", "deepseek/deepseek-v4-flash"],
  ["deepseek-v4-pro", "deepseek/deepseek-v4-pro"],
]);

export function normalizeOpenRouterApiModelId(modelId: unknown): string | undefined {
  if (typeof modelId !== "string") {
    return undefined;
  }
  const normalized = normalizeLowercaseStringOrEmpty(modelId);
  if (!normalized.startsWith(OPENROUTER_MODEL_PREFIX)) {
    return normalized;
  }
  const unprefixed = normalized.slice(OPENROUTER_MODEL_PREFIX.length);
  if (unprefixed.includes("/")) {
    return unprefixed;
  }
  // Expand known short aliases (e.g. "deepseek-v4-flash" → "deepseek/deepseek-v4-flash")
  // so downstream code receives a proper namespaced upstream model ID.
  const expanded = SHORT_MODEL_ALIASES.get(unprefixed);
  if (expanded) {
    return expanded;
  }
  // No known expansion: return the original prefixed form so the caller can
  // still attempt resolution rather than silently truncating the prefix.
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
