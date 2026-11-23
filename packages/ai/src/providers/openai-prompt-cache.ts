import { truncateCodePoints } from "@openclaw/normalization-core/code-points";
import { isNativeOpenAIEndpoint } from "../transports/openai-completions-compat.js";
import type { CacheRetention, Model, OpenAICompletionsCompat, StreamOptions } from "../types.js";

const EXTENDED_RETENTION_MODELS = new Set([
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5.4",
  "gpt-5.2",
  "gpt-5.1-codex-max",
  "gpt-5.1",
  "gpt-5.1-codex",
  "gpt-5.1-codex-mini",
  "gpt-5.1-chat-latest",
  "gpt-5",
  "gpt-5-codex",
  "gpt-4.1",
]);

/** Selects documented lifetime fields shared by Responses and Chat Completions. */
export function resolveOpenAIPromptCacheParams(
  model: Pick<Model, "id" | "provider" | "baseUrl">,
  cacheRetention: CacheRetention,
  compat: Required<
    Pick<OpenAICompletionsCompat, "supportsPromptCacheKey" | "supportsLongCacheRetention">
  >,
  // Only Responses callers supply these; Chat Completions keeps its existing behavior.
  promptCacheTtl?: StreamOptions["promptCacheTtl"],
  cachePrewarm?: StreamOptions["cachePrewarm"],
): {
  prompt_cache_retention?: "24h";
  prompt_cache_options?: { ttl?: "30m" | "12h"; prewarm?: boolean };
} {
  const lifetime = resolveOpenAIPromptCacheLifetimeParams(
    model,
    cacheRetention,
    compat,
    promptCacheTtl,
  );
  // A prewarm reads the prompt into the cache without output; the sent lifetime is unchanged.
  return cachePrewarm
    ? { ...lifetime, prompt_cache_options: { ...lifetime.prompt_cache_options, prewarm: true } }
    : lifetime;
}

function resolveOpenAIPromptCacheLifetimeParams(
  model: Pick<Model, "id" | "provider" | "baseUrl">,
  cacheRetention: CacheRetention,
  compat: Required<
    Pick<OpenAICompletionsCompat, "supportsPromptCacheKey" | "supportsLongCacheRetention">
  >,
  promptCacheTtl: StreamOptions["promptCacheTtl"],
): { prompt_cache_retention?: "24h"; prompt_cache_options?: { ttl: "30m" | "12h" } } {
  if (
    cacheRetention === "none" ||
    !compat.supportsPromptCacheKey ||
    !compat.supportsLongCacheRetention
  ) {
    return {};
  }
  // GPT-5.6 and later replace legacy retention on both APIs.
  // https://developers.openai.com/api/docs/guides/prompt-caching#cache-lifetime
  if (isOpenAIPromptCacheOptionsModel(model)) {
    return promptCacheTtl || cacheRetention === "long"
      ? { prompt_cache_options: { ttl: promptCacheTtl ?? "30m" } }
      : {};
  }
  if (cacheRetention !== "long") {
    return {};
  }
  const modelId = model.id.replace(/-\d{4}-\d{2}-\d{2}$/, "");
  return !isNativeOpenAIEndpoint(model) || EXTENDED_RETENTION_MODELS.has(modelId)
    ? { prompt_cache_retention: "24h" }
    : {};
}

/** GPT-5.6 and later: `prompt_cache_options`, with a documented 30-minute default lifetime. */
function isOpenAIPromptCacheOptionsModel(model: Pick<Model, "id">): boolean {
  const version = /^gpt-(\d+)(?:\.(\d+))?(?:-|$)/.exec(model.id);
  return Boolean(
    version && (Number(version[1]) > 5 || (Number(version[1]) === 5 && Number(version[2]) >= 6)),
  );
}

/**
 * The minimum prompt-cache lifetime a Responses request on this route is documented to get:
 * the requested `prompt_cache_options.ttl`, or the 30-minute default that native OpenAI applies
 * to GPT-5.6 and later when no lifetime is sent. Undefined when no lifetime is documented
 * (earlier models, compatible endpoints without a lifetime field, caching off).
 */
export function resolveOpenAIPromptCacheLifetimeMs(
  model: Pick<Model, "id" | "provider" | "baseUrl">,
  cacheRetention: CacheRetention,
  compat: Required<
    Pick<OpenAICompletionsCompat, "supportsPromptCacheKey" | "supportsLongCacheRetention">
  >,
  promptCacheTtl?: StreamOptions["promptCacheTtl"],
): number | undefined {
  const ttl = resolveOpenAIPromptCacheLifetimeParams(model, cacheRetention, compat, promptCacheTtl)
    .prompt_cache_options?.ttl;
  if (ttl) {
    return ttl === "12h" ? 12 * 60 * 60_000 : 30 * 60_000;
  }
  return cacheRetention !== "none" &&
    compat.supportsPromptCacheKey &&
    isNativeOpenAIEndpoint(model) &&
    isOpenAIPromptCacheOptionsModel(model)
    ? 30 * 60_000
    : undefined;
}

/** Maximum prompt cache key length accepted by OpenAI-compatible request metadata. */
export const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;

/** Truncates a prompt cache key by Unicode code point count. */
export function clampOpenAIPromptCacheKey(key: string | undefined): string | undefined {
  if (key === undefined) {
    return undefined;
  }
  return truncateCodePoints(key, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH);
}
