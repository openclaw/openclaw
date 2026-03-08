// Moonshot Kimi API rejects these JSON Schema validation keywords in tool definitions
// instead of ignoring them, causing errors for any request that includes them. Strip them
// before sending to Moonshot directly, or via OpenRouter/DeepInfra when the downstream model is Moonshot.
export const MOONSHOT_UNSUPPORTED_SCHEMA_KEYWORDS = new Set([
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "multipleOf",
  "pattern",
  "format",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "minContains",
  "maxContains",
  "patternProperties",
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "definitions",
  "examples",
]);

export function stripMoonshotUnsupportedKeywords(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  if (Array.isArray(schema)) {
    return schema.map(stripMoonshotUnsupportedKeywords);
  }
  const obj = schema as Record<string, unknown>;
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (MOONSHOT_UNSUPPORTED_SCHEMA_KEYWORDS.has(key)) {
      continue;
    }
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      cleaned[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [
          k,
          stripMoonshotUnsupportedKeywords(v),
        ]),
      );
    } else if (key === "items" && value && typeof value === "object") {
      cleaned[key] = Array.isArray(value)
        ? value.map(stripMoonshotUnsupportedKeywords)
        : stripMoonshotUnsupportedKeywords(value);
    } else if ((key === "anyOf" || key === "oneOf" || key === "allOf") && Array.isArray(value)) {
      cleaned[key] = value.map(stripMoonshotUnsupportedKeywords);
    } else {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

export function isMoonshotProvider(modelProvider?: string, modelId?: string): boolean {
  const provider = modelProvider?.toLowerCase() ?? "";
  if (provider.includes("moonshot")) {
    return true;
  }
  const lowerModelId = modelId?.toLowerCase() ?? "";
  // OpenRouter proxies to Moonshot when the model id includes "moonshot"
  if (provider === "openrouter" && lowerModelId.includes("moonshot")) {
    return true;
  }
  // DeepInfra proxies Moonshot models
  if (provider === "deepinfra" && lowerModelId.includes("moonshot")) {
    return true;
  }
  return false;
}
