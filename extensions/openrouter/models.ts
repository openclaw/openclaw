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

/**
 * Short, unnamespaced model refs that OpenClaw catalog/config surfaces accept
 * as `openrouter/<short>`, but which the OpenRouter API exposes under a
 * namespaced upstream id. Without this expansion, the API normalizer would
 * see the stripped remainder lack a `/`, treat the original ref as a native
 * OpenRouter route (like `openrouter/auto`), and send the wrong slug
 * upstream — yielding `400 model_not_found` (#95198).
 *
 * Keep entries narrowly scoped: only short aliases that OpenClaw already
 * surfaces as `openrouter/<short>` elsewhere. The DeepSeek V4 family is
 * tracked at this layer because `isOpenRouterDeepSeekV4ModelId` already
 * recognizes both ids, and the user-reported broken cases were both of them.
 */
const OPENROUTER_SHORT_TO_API_MODEL_ID = new Map<string, string>([
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
  // Known short aliases must expand to their namespaced upstream id even
  // though the stripped remainder lacks a `/`. Without this, an
  // `openrouter/deepseek-v4-flash` ref would otherwise fall through to the
  // legacy native-route branch below and OpenRouter would reject the
  // unexpanded short id with `400 model_not_found` (#95198).
  const aliased = OPENROUTER_SHORT_TO_API_MODEL_ID.get(unprefixed);
  if (aliased) {
    return aliased;
  }
  // `openrouter/` is both a provider qualifier and an upstream namespace.
  // Strip it only when the remainder is still a namespaced API model id.
  return unprefixed.includes("/") ? unprefixed : normalized;
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
