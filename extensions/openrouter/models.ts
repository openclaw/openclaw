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
  // Strip it when the remainder is a namespaced API model id (e.g., "deepseek/deepseek-v4-flash")
  // or a short canonical model id (e.g., "deepseek-v4-flash").
  // Keep it for special OpenRouter-only models (e.g., "auto", "fusion") or when remainder is empty/invalid.
  if (!unprefixed || unprefixed.startsWith("/") || !unprefixed.includes("/")) {
    return normalized;
  }
  return unprefixed;
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
