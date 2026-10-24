// Browser-safe JSON Schema normalization and value checks shared by core and Control UI.
import { Guard } from "typebox/guard";
import { Check } from "typebox/schema";
import { isRecord, isStringArray } from "./record-coerce.js";

type JsonSchemaObject = Record<string, unknown>;
export type JsonSchemaValue = JsonSchemaObject | boolean;

/** Decode a local URI fragment before recognizing or splitting its JSON Pointer. */
export function decodeLocalSchemaRefFragment(ref: string): string | undefined {
  if (!ref.startsWith("#")) {
    return undefined;
  }
  try {
    return decodeURIComponent(ref.slice(1));
  } catch {
    return undefined;
  }
}

export function decodeJsonPointerSegment(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

/** Encoded slashes separate tokens; ~1 remains inside a single token. */
export function parseLocalSchemaRefPointer(ref: string): string[] | undefined {
  const fragment = decodeLocalSchemaRefFragment(ref);
  return fragment?.startsWith("/")
    ? fragment.slice(1).split("/").map(decodeJsonPointerSegment)
    : undefined;
}

/** Validation details shared by the TypeBox schema and value compilers. */
export type TypeBoxValidationError = {
  keyword?: string;
  instancePath?: string;
  schemaPath?: string;
  params?: Record<string, unknown>;
  message?: string;
};

/** Remove complete false-schema child groups immediately preceding their aggregate. */
export function normalizeTypeBoxValidationErrors<T extends TypeBoxValidationError>(
  errors: T[],
): T[] {
  const normalized: T[] = [];
  let consecutiveBooleanErrors = 0;
  for (const error of errors) {
    if (error.keyword === "boolean") {
      normalized.push(error);
      consecutiveBooleanErrors += 1;
      continue;
    }
    const properties = error.params?.additionalProperties;
    if (
      error.keyword === "additionalProperties" &&
      typeof error.schemaPath === "string" &&
      typeof error.instancePath === "string" &&
      Array.isArray(properties) &&
      properties.length > 0 &&
      properties.length <= consecutiveBooleanErrors
    ) {
      const children = normalized.slice(-properties.length);
      // TypeBox emits this group immediately before its aggregate, in property order.
      // Matching only that suffix preserves genuine errors with colliding raw paths.
      if (
        children.every((child, index) => {
          const property = properties[index];
          return (
            typeof property === "string" &&
            child.schemaPath === `${error.schemaPath}/additionalProperties` &&
            child.instancePath ===
              `${error.instancePath}/${property.replace(/~/g, "~0").replace(/\//g, "~1")}`
          );
        })
      ) {
        normalized.length -= properties.length;
      }
    }
    normalized.push(error);
    consecutiveBooleanErrors = 0;
  }
  return normalized;
}

const schemaMapKeywords = new Set([
  "$defs",
  "definitions",
  "dependentSchemas",
  "dependencies",
  "patternProperties",
  "properties",
]);
const schemaValueKeywords = new Set([
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
const schemaResourceKeywords = new Set([
  "$anchor",
  "$defs",
  "$dynamicAnchor",
  "$id",
  "$recursiveAnchor",
  "$schema",
  "$vocabulary",
  "definitions",
]);

export type JsonSchemaRefinement = {
  check: (value: unknown) => boolean;
  error: (value: unknown) => string;
};

type NormalizationOptions = {
  /** Treat format keywords as annotations without changing literal data or property names. */
  format?: "annotation";
};

type SchemaAncestors = readonly Record<string, unknown>[];
type SchemaNodeMapper = (
  schema: Record<string, unknown>,
  ancestors: SchemaAncestors,
) => Record<string, unknown>;

function mapSchemaChildren(
  value: unknown,
  mapper: SchemaNodeMapper,
  preserveStringArrays: boolean,
  ancestors: SchemaAncestors,
): unknown {
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      preserveStringArrays && isStringArray(entry)
        ? entry
        : mapJsonSchemaNode(entry, mapper, ancestors),
    ]),
  );
}

function mapJsonSchemaNode(
  schema: JsonSchemaValue,
  mapper: SchemaNodeMapper,
  ancestors?: SchemaAncestors,
): JsonSchemaValue;
function mapJsonSchemaNode(
  schema: unknown,
  mapper: SchemaNodeMapper,
  ancestors?: SchemaAncestors,
): unknown;
function mapJsonSchemaNode(
  schema: unknown,
  mapper: SchemaNodeMapper,
  ancestors: SchemaAncestors = [],
): unknown {
  if (Array.isArray(schema)) {
    return schema.map((entry) => mapJsonSchemaNode(entry, mapper, ancestors));
  }
  if (!isRecord(schema)) {
    return schema;
  }
  const childrenAncestors = [...ancestors, schema];
  return Object.fromEntries(
    Object.entries(mapper(schema, ancestors)).map(([key, value]) => {
      if (schemaMapKeywords.has(key)) {
        return [key, mapSchemaChildren(value, mapper, key === "dependencies", childrenAncestors)];
      }
      if (schemaValueKeywords.has(key)) {
        return [key, mapJsonSchemaNode(value, mapper, childrenAncestors)];
      }
      return [key, value];
    }),
  );
}

/** Transform schema nodes without traversing literal values or property names as schemas. */
export function mapJsonSchema(schema: JsonSchemaValue, mapper: SchemaNodeMapper): JsonSchemaValue {
  return mapJsonSchemaNode(schema, mapper);
}

function compilesUnicodePattern(pattern: string): boolean {
  try {
    const probe = new RegExp(pattern, "u");
    void probe;
    return true;
  } catch {
    return false;
  }
}

function repairJsonSchemaPatternForUnicodeRegExp(pattern: string): string {
  if (compilesUnicodePattern(pattern)) {
    return pattern;
  }
  const repaired = pattern.replace(/\\([^\\])/g, (match, ch: string) => {
    if (ch === ":" || ch === "/") {
      return ch;
    }
    return match;
  });
  return compilesUnicodePattern(repaired) ? repaired : pattern;
}

function normalizePatternProperties(value: Record<string, unknown>): Record<string, unknown> {
  const normalized = new Map<string, unknown>();
  for (const [pattern, propertySchema] of Object.entries(value)) {
    const repairedPattern = repairJsonSchemaPatternForUnicodeRegExp(pattern);
    const existingSchema = normalized.get(repairedPattern);
    normalized.set(
      repairedPattern,
      existingSchema === undefined ? propertySchema : { allOf: [existingSchema, propertySchema] },
    );
  }
  return Object.fromEntries(normalized);
}

function expandJsonSchemaTypeArray(schema: Record<string, unknown>): Record<string, unknown> {
  const { nullable, type, ...rest } = schema;
  const types = Array.isArray(type) ? [...type] : typeof type === "string" ? [type] : null;
  if (!types) {
    return schema;
  }
  if (nullable === true && !types.includes("null")) {
    types.push("null");
  }
  if (types.length === 1 && !Array.isArray(type)) {
    return schema;
  }
  const entries = Object.entries(rest);
  const resourceEntries = entries.filter(([key]) => schemaResourceKeywords.has(key));
  const branch = Object.fromEntries(entries.filter(([key]) => !schemaResourceKeywords.has(key)));
  // Keep value-wide constraints on every branch: const, enum, and applicators
  // must still decide whether null is valid. Type-specific keywords ignore null.
  return {
    ...Object.fromEntries(resourceEntries),
    anyOf: types.map((entry) => Object.assign({}, branch, { type: entry })),
  };
}

function normalizeAdditionalPropertiesSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (
    !isRecord(schema.additionalProperties) ||
    isRecord(schema.properties) ||
    isRecord(schema.patternProperties)
  ) {
    return schema;
  }
  const { additionalProperties, ...rest } = schema;
  return {
    ...rest,
    patternProperties: {
      ".*": additionalProperties,
    },
    additionalProperties: false,
  };
}

function normalizeJsonSchemaObject(
  schema: Record<string, unknown>,
  options: NormalizationOptions,
): Record<string, unknown> {
  const schemaWithNullableEnum =
    schema.nullable === true &&
    schema.enumIncludesNull === true &&
    Array.isArray(schema.enum) &&
    !schema.enum.some((entry) => entry === null)
      ? { ...schema, enum: [...schema.enum, null] }
      : schema;
  const normalizedSchema = normalizeAdditionalPropertiesSchema(
    expandJsonSchemaTypeArray(schemaWithNullableEnum),
  );
  return Object.fromEntries(
    Object.entries(normalizedSchema)
      .filter(([key]) => key !== "format" || options.format !== "annotation")
      .map(([key, value]) => {
        if (key === "$dynamicRef" && normalizedSchema.$ref === undefined) {
          return ["$ref", value];
        }
        if (key === "pattern" && typeof value === "string") {
          return [key, repairJsonSchemaPatternForUnicodeRegExp(value)];
        }
        if (key === "patternProperties" && isRecord(value)) {
          return [key, normalizePatternProperties(value)];
        }
        return [key, value];
      }),
  );
}

function isJsonValue(
  value: unknown,
  active = new WeakSet<object>(),
  complete = new WeakSet<object>(),
): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value !== "object") {
    return false;
  }
  let entries: unknown[];
  try {
    if (Array.isArray(value)) {
      const ownKeys = Reflect.ownKeys(value);
      if (
        ownKeys.length !== value.length + 1 ||
        ownKeys.some((key) => {
          if (key === "length") {
            return false;
          }
          if (typeof key !== "string") {
            return true;
          }
          const index = Number(key);
          return (
            !Number.isSafeInteger(index) ||
            index < 0 ||
            index >= value.length ||
            String(index) !== key
          );
        })
      ) {
        return false;
      }
      entries = value;
    } else {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        return false;
      }
      const ownKeys = Reflect.ownKeys(value);
      if (
        ownKeys.some(
          (key) =>
            typeof key !== "string" || !Object.prototype.propertyIsEnumerable.call(value, key),
        )
      ) {
        return false;
      }
      entries = Object.values(value);
    }
  } catch {
    return false;
  }
  if (complete.has(value)) {
    return true;
  }
  if (active.has(value)) {
    return false;
  }
  active.add(value);
  const valid = entries.every((entry) => isJsonValue(entry, active, complete));
  active.delete(value);
  if (valid) {
    complete.add(value);
  }
  return valid;
}

/** Normalize JSON Schema constructs into the TypeBox runtime subset used by validators. */
export function normalizeJsonSchemaForTypeBox(
  schema: JsonSchemaValue,
  options: NormalizationOptions = {},
): JsonSchemaValue {
  return mapJsonSchema(schema, (node) => normalizeJsonSchemaObject(node, options));
}

/** Capture a schema's format policy without changing default or reference placement. */
export function prepareJsonSchemaFormats(
  schema: JsonSchemaValue,
  formats: ReadonlyMap<string, JsonSchemaRefinement>,
): JsonSchemaValue {
  return mapJsonSchema(schema, (node) => {
    const { format, ...prepared } = node;
    const refinement = typeof format === "string" ? formats.get(format) : undefined;
    if (!refinement) {
      return prepared;
    }
    const refinements = Array.isArray(prepared["~refine"]) ? prepared["~refine"] : [];
    return { ...prepared, "~refine": [...refinements, refinement] };
  });
}

/** Compare acyclic JSON values using the same equality semantics as TypeBox. */
export function jsonSchemaValuesEqual(left: unknown, right: unknown): boolean {
  if (!isJsonValue(left) || !isJsonValue(right)) {
    return false;
  }
  try {
    return Guard.IsDeepEqual(left, right);
  } catch {
    return false;
  }
}

/** Validate an acyclic JSON value against the canonical normalized schema. */
export function isJsonSchemaValueValid(schema: JsonSchemaValue, value: unknown): boolean {
  if (!isJsonValue(value)) {
    return false;
  }
  try {
    return Check(normalizeJsonSchemaForTypeBox(schema) as never, value);
  } catch {
    return false;
  }
}
