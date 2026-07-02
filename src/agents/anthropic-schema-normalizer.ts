const SCHEMA_MAP_KEYS = new Set([
  "$defs",
  "definitions",
  "dependentSchemas",
  "patternProperties",
  "properties",
]);

const SCHEMA_NESTED_KEYS = new Set([
  "additionalItems",
  "additionalProperties",
  "allOf",
  "anyOf",
  "contains",
  "else",
  "if",
  "items",
  "not",
  "oneOf",
  "prefixItems",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);

function normalizeSchemaMap(schema: unknown): unknown {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return schema;
  }
  let changed = false;
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    const next = normalizeDraft2020_12Recursive(value);
    normalized[key] = next;
    changed ||= next !== value;
  }
  return changed ? normalized : schema;
}

function normalizeDraft2020_12Recursive(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    let changed = false;
    const normalized = schema.map((entry) => {
      const next = normalizeDraft2020_12Recursive(entry);
      changed ||= next !== entry;
      return next;
    });
    return changed ? normalized : schema;
  }
  if (!schema || typeof schema !== "object") {
    return schema;
  }

  const record = schema as Record<string, unknown>;
  let changed = false;
  const normalized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(record)) {
    const next = SCHEMA_MAP_KEYS.has(key)
      ? normalizeSchemaMap(value)
      : SCHEMA_NESTED_KEYS.has(key)
        ? normalizeDraft2020_12Recursive(value)
        : value;
    normalized[key] = next;
    changed ||= next !== value;
  }

  // Convert draft-07 tuple items: [A, B] → draft 2020-12 prefixItems: [A, B]
  if (Array.isArray(normalized.items)) {
    if (!("prefixItems" in normalized)) {
      normalized.prefixItems = normalized.items;
    }
    delete normalized.items;
    changed = true;
  }

  // Convert draft-07 additionalItems → draft 2020-12 items
  if ("additionalItems" in normalized) {
    if (!("items" in normalized)) {
      normalized.items = normalized.additionalItems;
    }
    delete normalized.additionalItems;
    changed = true;
  }

  return changed ? normalized : schema;
}

/**
 * Recursively normalizes a JSON Schema from draft-07 tuple syntax to draft
 * 2020-12 so it is accepted by Anthropic models (opus-4-8+) that enforce
 * draft 2020-12 compliance on tool input_schema.
 *
 * Conversions:
 * - `items: [A, B, C]` → `prefixItems: [A, B, C]` (tuple arrays only)
 * - `additionalItems: X`  → `items: X`
 *
 * Single-schema `items: {…}` and `items: false` are left unchanged.
 * Returns the original object reference when no changes are needed.
 */
export function normalizeAnthropicSchema(schema: unknown): unknown {
  return normalizeDraft2020_12Recursive(schema);
}
