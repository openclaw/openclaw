// Memory Host SDK helper module supports embedding provider adapter utils behavior.
import { normalizeLowercaseStringOrEmpty } from "./string-utils.js";

// Adapter helpers shared by remote embedding provider implementations.

/** Detect missing API key errors from provider auth resolution. */
export function isMissingEmbeddingApiKeyError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("No API key found for provider");
}

/**
 * Canonical secret-bearing header names that must never enter cache identity.
 * Cache identity is hashed into the memory provider key, so an auth/credential
 * header would otherwise change the provider key and force a full reindex on
 * every credential rotation. Applied to every adapter via sanitizeEmbeddingCacheHeaders.
 */
function isSensitiveEmbeddingHeaderName(name: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(name);
  return (
    normalized === "authorization" ||
    normalized === "proxy-authorization" ||
    normalized.includes("api-key") ||
    normalized.includes("token") ||
    normalized.includes("secret")
  );
}

/**
 * Return stable cache headers after removing secret headers. Sensitive headers
 * are always dropped (see isSensitiveEmbeddingHeaderName) so no adapter can leak
 * a credential into the provider-key hash; `excludedHeaderNames` removes extra
 * adapter-specific names on top of that.
 */
export function sanitizeEmbeddingCacheHeaders(
  headers: Record<string, string>,
  excludedHeaderNames: string[] = [],
): Array<[string, string]> {
  const excluded = new Set(
    excludedHeaderNames.map((name) => normalizeLowercaseStringOrEmpty(name)),
  );
  return Object.entries(headers)
    .filter(
      ([key]) =>
        !excluded.has(normalizeLowercaseStringOrEmpty(key)) && !isSensitiveEmbeddingHeaderName(key),
    )
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => [key, value]);
}

/** Convert custom-id keyed batch embeddings back to request-index order. */
export function mapBatchEmbeddingsByIndex(
  byCustomId: Map<string, number[]>,
  count: number,
): number[][] {
  const embeddings: number[][] = [];
  for (let index = 0; index < count; index += 1) {
    embeddings.push(byCustomId.get(String(index)) ?? []);
  }
  return embeddings;
}
