// Openrouter plugin module implements models behavior.
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

// Real OpenRouter model slugs that should be preserved with the openrouter/ prefix.
// These are official OpenRouter model identifiers, not routed refs.
const OPENROUTER_REAL_MODEL_SLUGS = new Set(["auto", "auto:free", "auto:lowest-latency"]);

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

export function normalizeOpenRouterModelId(modelId: unknown): string | undefined {
  if (typeof modelId !== "string") {
    return undefined;
  }
  const normalized = normalizeLowercaseStringOrEmpty(modelId);
  // Strip openrouter/ prefix for routed refs, preserve for real OpenRouter slugs.
  // - openrouter/auto → openrouter/auto (real slug, preserve)
  // - openrouter/anthropic/claude-sonnet-4.6 → anthropic/claude-sonnet-4.6 (nested, strip)
  // - openrouter/claude-sonnet-4-6 → claude-sonnet-4-6 (bare routed, strip)
  if (normalized.startsWith("openrouter/")) {
    const remainder = normalized.slice("openrouter/".length);
    if (remainder.includes("/")) {
      // Nested provider ref - strip openrouter/ prefix, keep nested provider.
      // e.g. openrouter/anthropic/claude-sonnet-4.6 → anthropic/claude-sonnet-4.6
      return remainder;
    }
    // No nested provider - check if it's a real OpenRouter slug to preserve.
    // e.g. openrouter/auto → openrouter/auto
    if (OPENROUTER_REAL_MODEL_SLUGS.has(remainder)) {
      return normalized;
    }
    // Bare routed ref - strip openrouter/ prefix.
    // e.g. openrouter/claude-sonnet-4-6 → claude-sonnet-4-6
    return remainder;
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
