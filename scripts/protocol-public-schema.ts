const INTERNAL_PROTOCOL_SCHEMA_PROPERTY = "x-openclaw-internal";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInternalSchema(value: unknown): boolean {
  return isRecord(value) && value[INTERNAL_PROTOCOL_SCHEMA_PROPERTY] === true;
}

export function stripInternalProtocolSchemaFields<T>(schema: T): T {
  return createInternalProtocolSchemaStripper()(schema);
}

export function createInternalProtocolSchemaStripper(): <T>(schema: T) => T {
  const seen = new WeakMap<object, unknown>();
  return <T>(schema: T): T => stripSchemaValue(schema, seen) as T;
}

function stripSchemaValue(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (Array.isArray(value)) {
    const cached = seen.get(value);
    if (cached) {
      return cached;
    }
    const result: unknown[] = [];
    seen.set(value, result);
    result.push(...value.map((entry) => stripSchemaValue(entry, seen)));
    return result;
  }
  if (!isRecord(value)) {
    return value;
  }
  const cached = seen.get(value);
  if (cached) {
    return cached;
  }

  const internalPropertyNames = new Set(
    isRecord(value.properties)
      ? Object.entries(value.properties)
          .filter(([, propertySchema]) => isInternalSchema(propertySchema))
          .map(([propertyName]) => propertyName)
      : [],
  );
  const result: Record<string, unknown> = {};
  seen.set(value, result);
  for (const [key, entry] of Object.entries(value)) {
    if (key === INTERNAL_PROTOCOL_SCHEMA_PROPERTY) {
      continue;
    }
    if (key === "properties" && isRecord(entry)) {
      const publicProperties: Record<string, unknown> = {};
      for (const [propertyName, propertySchema] of Object.entries(entry)) {
        if (isInternalSchema(propertySchema)) {
          internalPropertyNames.add(propertyName);
          continue;
        }
        publicProperties[propertyName] = stripSchemaValue(propertySchema, seen);
      }
      result[key] = publicProperties;
      continue;
    }
    if (key === "required" && Array.isArray(entry)) {
      result[key] = entry.filter(
        (propertyName) =>
          typeof propertyName !== "string" || !internalPropertyNames.has(propertyName),
      );
      continue;
    }
    result[key] = stripSchemaValue(entry, seen);
  }
  return result;
}
