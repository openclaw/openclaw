/**
 * Resolve the HTTP authentication headers for a model provider.
 *
 * After config loading, providers with `authHeader: true` already have an
 * `Authorization: Bearer <key>` entry in their `headers` map (injected by
 * `applyAuthHeaderToProviderHeaders` in config/io.ts).
 *
 * This helper merges all provider-level headers and falls back to `x-api-key`
 * when no explicit `Authorization` header is present — making it safe for any
 * code path that issues raw HTTP requests against provider endpoints (plugins,
 * extensions, etc.) without needing per-consumer auth-mode switching.
 */
export function resolveProviderRequestAuth(provider: {
  apiKey?: unknown;
  headers?: Record<string, unknown>;
}): Record<string, string> {
  const result: Record<string, string> = {};
  if (provider.headers && typeof provider.headers === "object") {
    for (const [key, value] of Object.entries(provider.headers)) {
      if (typeof value === "string") {
        result[key] = value;
      }
    }
  }
  if (!result.Authorization && provider.apiKey && typeof provider.apiKey === "string") {
    result["x-api-key"] = provider.apiKey;
  }
  return result;
}
