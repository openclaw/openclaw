/**
 * Provider-aware cache retention resolver.
 *
 * Moved out of anthropic-stream-wrappers.ts so the logic is not conceptually
 * trapped in an Anthropic-specific module.  Each provider family declares its
 * own resolution strategy:
 *
 *  - anthropic:      defaults to "short"; explicit config honored
 *  - amazon-bedrock: explicit-only (Anthropic models on Bedrock)
 *  - openai / openai-codex: explicit passthrough, no implicit default
 *  - everything else: undefined (no cache retention)
 */

export type CacheRetention = "none" | "short" | "long";

function isValidCacheRetention(val: unknown): val is CacheRetention {
  return val === "none" || val === "short" || val === "long";
}

function resolveLegacyCacheControlTtl(ttl: unknown): CacheRetention | undefined {
  if (ttl === "5m") {
    return "short";
  }
  if (ttl === "1h") {
    return "long";
  }
  return undefined;
}

/** Providers that pass through an explicit cacheRetention without adding a default. */
const EXPLICIT_PASSTHROUGH_PROVIDERS = new Set(["openai", "openai-codex"]);

export function resolveCacheRetention(
  extraParams: Record<string, unknown> | undefined,
  provider: string,
): CacheRetention | undefined {
  // ── Explicit value (new key) ──
  const newVal = extraParams?.cacheRetention;
  if (isValidCacheRetention(newVal)) {
    // Anthropic-direct and Bedrock-Anthropic always accept explicit values.
    // OpenAI/OpenAI-Codex pass through explicit values (no default added).
    if (
      provider === "anthropic" ||
      provider === "amazon-bedrock" ||
      EXPLICIT_PASSTHROUGH_PROVIDERS.has(provider)
    ) {
      return newVal;
    }
    // Other providers: ignore cache retention entirely.
    return undefined;
  }

  // ── Legacy key (cacheControlTtl) ──
  const legacy = resolveLegacyCacheControlTtl(extraParams?.cacheControlTtl);
  if (legacy !== undefined) {
    if (provider === "anthropic" || provider === "amazon-bedrock") {
      return legacy;
    }
    // Legacy key only meaningful for Anthropic family.
    return undefined;
  }

  // ── Implicit defaults ──
  if (provider === "anthropic") {
    return "short";
  }

  // amazon-bedrock, openai, openai-codex, and everything else: no implicit default.
  return undefined;
}
