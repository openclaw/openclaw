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

export function stripXaiUnsupportedKeywords(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  if (Array.isArray(schema)) {
    return schema.map(stripXaiUnsupportedKeywords);
  }
  const obj = schema as Record<string, unknown>;
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (XAI_UNSUPPORTED_SCHEMA_KEYWORDS.has(key)) {
      continue;
    }
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      cleaned[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [
          k,
          stripXaiUnsupportedKeywords(v),
        ]),
      );
    } else if (key === "items" && value && typeof value === "object") {
      cleaned[key] = Array.isArray(value)
        ? value.map(stripXaiUnsupportedKeywords)
        : stripXaiUnsupportedKeywords(value);
    } else if ((key === "anyOf" || key === "oneOf" || key === "allOf") && Array.isArray(value)) {
      cleaned[key] = value.map(stripXaiUnsupportedKeywords);
    } else {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

export function isVolcengineProvider(modelProvider?: string, modelId?: string): boolean {
  const provider = modelProvider?.toLowerCase() ?? "";
  const model = modelId?.toLowerCase() ?? "";
  if (provider.includes("volcengine") || provider.includes("ark")) {
    return true;
  }
  // Kimi models hosted on Volcengine share the same limitation
  if (model.includes("kimi")) {
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
