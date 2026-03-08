// Moonshot Kimi API rejects certain JSON Schema keywords in tool definitions.
// This module strips unsupported keywords to prevent 400 errors.

// Keywords that Moonshot API rejects or has issues with.
// Based on similar constraints in Gemini and xAI APIs.
export const MOONSHOT_UNSUPPORTED_SCHEMA_KEYWORDS = new Set([
  // Validation constraints that frequently cause issues
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

  // Meta keywords that may not be supported
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
  // OpenRouter and other proxies may use moonshotai/ prefix
  const lowerModelId = modelId?.toLowerCase() ?? "";
  if (provider === "openrouter" && lowerModelId.includes("moonshot")) {
    return true;
  }
  // DeepInfra proxies Moonshot models
  if (provider === "deepinfra" && lowerModelId.includes("moonshot")) {
    return true;
  }
  return false;
}
