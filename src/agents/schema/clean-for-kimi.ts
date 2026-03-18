import { normalizeProviderId } from "../model-selection.js";

const KIMI_NOISY_SCHEMA_KEYS = new Set([
  "$schema",
  "$id",
  "$defs",
  "definitions",
  "description",
  "title",
  "default",
  "examples",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "pattern",
  "format",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "contentEncoding",
  "contentMediaType",
]);

const KIMI_SESSIONS_SPAWN_OMIT_PROPERTIES = new Set(["resumeSessionId", "attachments", "attachAs"]);

type SchemaDefs = Map<string, unknown>;

function extendSchemaDefs(
  defs: SchemaDefs | undefined,
  schema: Record<string, unknown>,
): SchemaDefs | undefined {
  const defsEntry =
    schema.$defs && typeof schema.$defs === "object" && !Array.isArray(schema.$defs)
      ? (schema.$defs as Record<string, unknown>)
      : undefined;
  const legacyDefsEntry =
    schema.definitions &&
    typeof schema.definitions === "object" &&
    !Array.isArray(schema.definitions)
      ? (schema.definitions as Record<string, unknown>)
      : undefined;

  if (!defsEntry && !legacyDefsEntry) {
    return defs;
  }

  const next = defs ? new Map(defs) : new Map<string, unknown>();
  if (defsEntry) {
    for (const [key, value] of Object.entries(defsEntry)) {
      next.set(key, value);
    }
  }
  if (legacyDefsEntry) {
    for (const [key, value] of Object.entries(legacyDefsEntry)) {
      next.set(key, value);
    }
  }
  return next;
}

function decodeJsonPointerSegment(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function tryResolveLocalRef(ref: string, defs: SchemaDefs | undefined): unknown {
  if (!defs) {
    return undefined;
  }
  const match = ref.match(/^#\/(?:\$defs|definitions)\/(.+)$/);
  if (!match) {
    return undefined;
  }
  const name = decodeJsonPointerSegment(match[1] ?? "");
  return name ? defs.get(name) : undefined;
}

function compactSchemaNode(schema: unknown, defs?: SchemaDefs, refStack?: Set<string>): unknown {
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  if (Array.isArray(schema)) {
    return schema.map((entry) => compactSchemaNode(entry, defs, refStack));
  }

  const obj = schema as Record<string, unknown>;
  const nextDefs = extendSchemaDefs(defs, obj);
  const refValue = typeof obj.$ref === "string" ? obj.$ref : undefined;
  if (refValue) {
    if (refStack?.has(refValue)) {
      return {};
    }
    const resolved = tryResolveLocalRef(refValue, nextDefs);
    if (resolved !== undefined) {
      const nextRefStack = refStack ? new Set(refStack) : new Set<string>();
      nextRefStack.add(refValue);
      return compactSchemaNode(resolved, nextDefs, nextRefStack);
    }
    const { $ref: _ignoredRef, ...rest } = obj;
    return compactSchemaNode(rest, nextDefs, refStack);
  }

  const cleaned: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (KIMI_NOISY_SCHEMA_KEYS.has(key)) {
      continue;
    }
    if (key === "additionalProperties" && value === true) {
      continue;
    }
    if (
      key === "type" &&
      Array.isArray(value) &&
      value.every((entry) => typeof entry === "string")
    ) {
      const nonNullTypes = value.filter((entry) => entry !== "null");
      cleaned[key] =
        nonNullTypes.length === 1
          ? nonNullTypes[0]
          : nonNullTypes.length > 0
            ? nonNullTypes
            : value;
      continue;
    }
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      cleaned[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([propertyName, propertySchema]) => [
          propertyName,
          compactSchemaNode(propertySchema, nextDefs, refStack),
        ]),
      );
      continue;
    }
    if (key === "items" && value && typeof value === "object") {
      cleaned[key] = Array.isArray(value)
        ? value.map((entry) => compactSchemaNode(entry, nextDefs, refStack))
        : compactSchemaNode(value, nextDefs, refStack);
      continue;
    }
    if ((key === "anyOf" || key === "oneOf" || key === "allOf") && Array.isArray(value)) {
      cleaned[key] = value.map((entry) => compactSchemaNode(entry, nextDefs, refStack));
      continue;
    }
    cleaned[key] = value;
  }

  return cleaned;
}

export function compactToolSchemaForKimi(
  schema: unknown,
  options?: { toolName?: string },
): unknown {
  const compacted = compactSchemaNode(schema);
  if (
    options?.toolName !== "sessions_spawn" ||
    !compacted ||
    typeof compacted !== "object" ||
    Array.isArray(compacted)
  ) {
    return compacted;
  }

  const record = compacted as Record<string, unknown>;
  const properties =
    record.properties && typeof record.properties === "object" && !Array.isArray(record.properties)
      ? (record.properties as Record<string, unknown>)
      : undefined;

  if (!properties) {
    return compacted;
  }

  const nextProperties = Object.fromEntries(
    Object.entries(properties).filter(([key]) => !KIMI_SESSIONS_SPAWN_OMIT_PROPERTIES.has(key)),
  );
  const nextRequired = Array.isArray(record.required)
    ? record.required.filter(
        (entry) => typeof entry !== "string" || !KIMI_SESSIONS_SPAWN_OMIT_PROPERTIES.has(entry),
      )
    : record.required;

  return {
    ...record,
    properties: nextProperties,
    ...(Array.isArray(nextRequired) ? { required: nextRequired } : {}),
  };
}

export function isKimiSchemaCompactionTarget(modelProvider?: string, modelId?: string): boolean {
  const provider = modelProvider ? normalizeProviderId(modelProvider) : "";
  if (provider.includes("kimi-coding") || provider.includes("anthropic")) {
    return false;
  }
  const normalizedModelId = modelId?.trim().toLowerCase() ?? "";
  return normalizedModelId.length > 0 && normalizedModelId.includes("kimi");
}
