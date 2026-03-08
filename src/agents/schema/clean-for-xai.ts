// xAI rejects these JSON Schema validation keywords in tool definitions instead of
// ignoring them, causing 502 errors for any request that includes them.  Strip them
// before sending to xAI directly, or via OpenRouter when the downstream model is xAI.
export const XAI_UNSUPPORTED_SCHEMA_KEYWORDS = new Set([
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minContains",
  "maxContains",
]);

// Moonshot/Kimi rejects numeric constraints in addition to the string/array
// constraints that xAI rejects.
export const MOONSHOT_UNSUPPORTED_SCHEMA_KEYWORDS = new Set([
  ...XAI_UNSUPPORTED_SCHEMA_KEYWORDS,
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
]);

export function stripUnsupportedSchemaKeywords(schema: unknown, keywords: Set<string>): unknown {
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  if (Array.isArray(schema)) {
    return schema.map((item) => stripUnsupportedSchemaKeywords(item, keywords));
  }
  const obj = schema as Record<string, unknown>;
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (keywords.has(key)) {
      continue;
    }
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      cleaned[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [
          k,
          stripUnsupportedSchemaKeywords(v, keywords),
        ]),
      );
    } else if (key === "items" && value && typeof value === "object") {
      cleaned[key] = Array.isArray(value)
        ? value.map((item) => stripUnsupportedSchemaKeywords(item, keywords))
        : stripUnsupportedSchemaKeywords(value, keywords);
    } else if ((key === "anyOf" || key === "oneOf" || key === "allOf") && Array.isArray(value)) {
      cleaned[key] = value.map((item) => stripUnsupportedSchemaKeywords(item, keywords));
    } else {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

export function stripXaiUnsupportedKeywords(schema: unknown): unknown {
  return stripUnsupportedSchemaKeywords(schema, XAI_UNSUPPORTED_SCHEMA_KEYWORDS);
}

export function stripMoonshotUnsupportedKeywords(schema: unknown): unknown {
  return stripUnsupportedSchemaKeywords(schema, MOONSHOT_UNSUPPORTED_SCHEMA_KEYWORDS);
}

export function isMoonshotProvider(modelProvider?: string, modelId?: string): boolean {
  const provider = modelProvider?.toLowerCase() ?? "";
  if (provider === "moonshot") {
    return true;
  }
  const lowerModelId = modelId?.toLowerCase() ?? "";
  // OpenRouter / Together proxy to Moonshot/Kimi models
  if (
    (provider === "openrouter" || provider === "together") &&
    (lowerModelId.startsWith("moonshotai/") || lowerModelId.includes("kimi"))
  ) {
    return true;
  }
  return false;
}

export function isXaiProvider(modelProvider?: string, modelId?: string): boolean {
  const provider = modelProvider?.toLowerCase() ?? "";
  if (provider.includes("xai") || provider.includes("x-ai")) {
    return true;
  }
  const lowerModelId = modelId?.toLowerCase() ?? "";
  // OpenRouter proxies to xAI when the model id starts with "x-ai/"
  if (provider === "openrouter" && lowerModelId.startsWith("x-ai/")) {
    return true;
  }
  // Venice proxies to xAI/Grok models
  if (provider === "venice" && lowerModelId.includes("grok")) {
    return true;
  }
  return false;
}
