// llama.cpp's GBNF grammar converter crashes on several JSON Schema keywords that
// became common after the 2026.3.2 SecretRef expansion and zod schema deduplication.
// Tool definitions forwarded to llama.cpp-compatible endpoints now include
// $schema, additionalProperties, and complex anyOf/oneOf structures that the GBNF
// converter cannot handle, producing degenerate grammars that match fewer tool calls.
// Strip these before sending tool schemas to llama.cpp-compatible endpoints.

export const LLAMACPP_UNSUPPORTED_SCHEMA_KEYWORDS = new Set([
  "$schema",
  "additionalProperties",
  "$ref",
]);

export function stripLlamaCppUnsupportedKeywords(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  if (Array.isArray(schema)) {
    return schema.map(stripLlamaCppUnsupportedKeywords);
  }
  const obj = schema as Record<string, unknown>;

  // Collapse anyOf/oneOf to the first concrete (non-null) branch.
  // llama.cpp's GBNF grammar converter fails on complex union types.
  for (const key of ["anyOf", "oneOf"] as const) {
    if (Array.isArray(obj[key])) {
      const variants = obj[key] as unknown[];
      const concrete =
        variants.find(
          (v) => v && typeof v === "object" && (v as Record<string, unknown>).type !== "null",
        ) ?? variants[0];
      return stripLlamaCppUnsupportedKeywords(concrete);
    }
  }

  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (LLAMACPP_UNSUPPORTED_SCHEMA_KEYWORDS.has(key)) {
      continue;
    }
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      cleaned[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [
          k,
          stripLlamaCppUnsupportedKeywords(v),
        ]),
      );
    } else if (key === "items" && value && typeof value === "object") {
      cleaned[key] = Array.isArray(value)
        ? value.map(stripLlamaCppUnsupportedKeywords)
        : stripLlamaCppUnsupportedKeywords(value);
    } else {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

export function isLlamaCppProvider(modelProvider?: string, modelBaseUrl?: string): boolean {
  const provider = modelProvider?.toLowerCase().trim() ?? "";
  if (
    provider.includes("llamacpp") ||
    provider.includes("llama-cpp") ||
    provider.includes("llama.cpp") ||
    provider.includes("lmstudio") ||
    provider.includes("lm-studio")
  ) {
    return true;
  }
  if (!modelBaseUrl) {
    return false;
  }
  try {
    const parsed = new URL(modelBaseUrl);
    // llama.cpp server default port is 8080; only trust localhost to avoid
    // false-positives for remote services that happen to run on 8080.
    if (parsed.port === "8080") {
      const hostname = parsed.hostname.toLowerCase();
      const isLocalhost =
        hostname === "localhost" ||
        hostname === "127.0.0.1" ||
        hostname === "::1" ||
        hostname === "[::1]";
      return isLocalhost;
    }
  } catch {
    // ignore invalid URLs
  }
  return false;
}
