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
// Known OpenRouter-native model identifiers that the API expects with the
// `openrouter/` prefix intact. Short model refs not matching these patterns
// get the prefix stripped for API calls (e.g. openrouter/deepseek-v4-flash →
// deepseek-v4-flash, #95198).
const OPENROUTER_NATIVE_IDS = new Set(["auto", "auto:free", "auto:lowest-latency", "fusion"]);
const OPENROUTER_NATIVE_ID_PREFIXES = ["hunter-alpha"] as const;

function isOpenRouterNativeModelId(unprefixed: string): boolean {
  if (OPENROUTER_NATIVE_IDS.has(unprefixed)) {
    return true;
  }
  return OPENROUTER_NATIVE_ID_PREFIXES.some(
    (prefix) => unprefixed === prefix || unprefixed.startsWith(`${prefix}:`),
  );
}

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
  // Strip it when the remainder is a provider-namespaced API model id
  // (e.g. openrouter/anthropic/claude-sonnet-4.6 → anthropic/claude-sonnet-4.6)
  // or a short-form model ref that isn't a known OpenRouter-native identifier
  // (e.g. openrouter/deepseek-v4-flash → deepseek-v4-flash, #95198).
  if (unprefixed.includes("/") || !isOpenRouterNativeModelId(unprefixed)) {
    return unprefixed;
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
