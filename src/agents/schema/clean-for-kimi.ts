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

function compactSchemaNode(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  if (Array.isArray(schema)) {
    return schema.map((entry) => compactSchemaNode(entry));
  }

  const obj = schema as Record<string, unknown>;
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
          compactSchemaNode(propertySchema),
        ]),
      );
      continue;
    }
    if (key === "items" && value && typeof value === "object") {
      cleaned[key] = Array.isArray(value)
        ? value.map((entry) => compactSchemaNode(entry))
        : compactSchemaNode(value);
      continue;
    }
    if ((key === "anyOf" || key === "oneOf" || key === "allOf") && Array.isArray(value)) {
      cleaned[key] = value.map((entry) => compactSchemaNode(entry));
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
  const provider = modelProvider?.trim().toLowerCase() ?? "";
  if (provider.includes("kimi-coding") || provider.includes("anthropic")) {
    return false;
  }
  const normalizedModelId = modelId?.trim().toLowerCase() ?? "";
  if (normalizedModelId.length === 0) {
    return provider === "moonshot";
  }
  return normalizedModelId.includes("kimi");
}
