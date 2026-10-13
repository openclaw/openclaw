import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { TSchema } from "typebox";
import { SCHEMA_MAP_KEYS, SCHEMA_NESTED_KEYS } from "./schema-walk.js";
import { normalizeToolSchema } from "./tool-schema-normalization.js";

/** Repairs recoverable OpenAI tool-schema shapes before canonical normalization. */
export function normalizeOpenAIStrictCompatSchema(schema: unknown): TSchema {
  return normalizeToolSchema(schema, "compat") as TSchema;
}

/**
 * Returns whether a regex pattern contains a lookahead or lookbehind group.
 * Escaped parentheses, character classes, and named groups are not lookarounds.
 */
function hasRegexLookaround(pattern: string): boolean {
  let inCharacterClass = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "\\") {
      index += 1;
    } else if (inCharacterClass) {
      inCharacterClass = char !== "]";
    } else if (char === "[") {
      inCharacterClass = true;
    } else if (char === "(" && /^\?<?[=!]/.test(pattern.slice(index + 1, index + 4))) {
      return true;
    }
  }
  return false;
}

/** Finds schema paths that violate OpenAI strict tool-schema requirements. */
export function findOpenAIStrictSchemaViolations(
  schema: unknown,
  path: string,
  options?: { requireObjectRoot?: boolean },
): string[] {
  if (Array.isArray(schema)) {
    if (options?.requireObjectRoot) {
      return [`${path}.type`];
    }
    return schema.flatMap((item, index) =>
      findOpenAIStrictSchemaViolations(item, `${path}[${index}]`),
    );
  }
  if (!schema || typeof schema !== "object") {
    return options?.requireObjectRoot ? [`${path}.type`] : [];
  }

  const record = schema as Record<string, unknown>;
  const violations: string[] = [];
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    if (key in record) {
      violations.push(`${path}.${key}`);
    }
  }
  if (Array.isArray(record.type)) {
    violations.push(`${path}.type`);
  }
  if (typeof record.pattern === "string" && hasRegexLookaround(record.pattern)) {
    violations.push(`${path}.pattern`);
  }

  const properties = isRecord(record.properties) ? record.properties : undefined;

  if (record.type === "object") {
    if (record.additionalProperties !== false) {
      violations.push(`${path}.additionalProperties`);
    }
    const required = Array.isArray(record.required)
      ? record.required.filter((entry): entry is string => typeof entry === "string")
      : undefined;
    if (!required) {
      violations.push(`${path}.required`);
    } else if (properties) {
      const requiredSet = new Set(required);
      for (const key of Object.keys(properties)) {
        if (!requiredSet.has(key)) {
          violations.push(`${path}.required.${key}`);
        }
      }
    }
  }

  // Schema maps contain user-chosen names. Walk their values as schemas, but
  // never interpret map keys such as `$defs.anyOf` as schema keywords.
  for (const key of SCHEMA_MAP_KEYS) {
    const schemaMap = record[key];
    if (!isRecord(schemaMap)) {
      continue;
    }
    for (const [entryKey, value] of Object.entries(schemaMap)) {
      violations.push(...findOpenAIStrictSchemaViolations(value, `${path}.${key}.${entryKey}`));
    }
  }
  // Only recurse through JSON Schema applicators. Annotation payloads such as
  // examples/default may contain arbitrary objects that are not schemas.
  for (const key of SCHEMA_NESTED_KEYS) {
    const value = record[key];
    if (value && typeof value === "object") {
      violations.push(...findOpenAIStrictSchemaViolations(value, `${path}.${key}`));
    }
  }

  return violations;
}
