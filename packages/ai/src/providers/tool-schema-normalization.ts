import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { SCHEMA_MAP_KEYS, SCHEMA_NESTED_KEYS } from "./schema-walk.js";
import {
  inheritToolSchemaTruncation,
  reportToolSchemaTruncation,
  truncateToolSchemaDepth,
  wasToolSchemaTruncated,
} from "./tool-schema-depth.js";
import { getPublishedRuntimeToolInputSchema } from "./tool-schema-json-projection.js";
import { createToolSchemaNormalizationCache } from "./tool-schema-normalization-cache.js";
import {
  copySchemaMeta,
  SCHEMA_MAP_KEYS as OPENAPI_MAP_KEYS,
  SCHEMA_OBJECT_KEYS as OPENAPI_OBJECT_KEYS,
  SCHEMA_ARRAY_KEYS as OPENAPI_ARRAY_KEYS,
  SCHEMA_LITERAL_KEYS,
} from "./tool-schema-refs.js";

const OPENAPI_SCHEMA_ANNOTATION_KEYS = new Set([
  "discriminator",
  "externalDocs",
  "readOnly",
  "writeOnly",
  "xml",
  "example",
]);

function isNullSchemaLike(schema: unknown): boolean {
  if (!isRecord(schema)) {
    return false;
  }
  if (schema.type === "null") {
    return true;
  }
  if (Array.isArray(schema.type) && schema.type.includes("null")) {
    return true;
  }
  if ("const" in schema && schema.const === null) {
    return true;
  }
  return Array.isArray(schema.enum) && schema.enum.includes(null);
}

// Annotation-only keywords whose null values can be dropped without changing
// what the schema accepts; null constraint keywords must stay so projection
// quarantines the tool instead of widening it.
const OPENAI_NULLABLE_ANNOTATION_KEYS = new Set([
  "default",
  "description",
  "examples",
  "format",
  "title",
]);

function inferUnionBranchType(schema: Record<string, unknown>): string | undefined {
  const types = new Set<string>();
  const values = "const" in schema ? [schema.const] : schema.enum;
  if (Array.isArray(values)) {
    for (const value of values) {
      types.add(value === null ? "null" : Array.isArray(value) ? "array" : typeof value);
    }
  }
  for (const [type, keywords] of [
    ["number", ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"]],
    ["string", ["minLength", "maxLength", "pattern", "format"]],
    ["object", ["properties", "required"]],
    ["array", ["items"]],
  ] as const) {
    if (keywords.some((key) => key in schema)) {
      types.add(type);
    }
  }
  // Conflicting hints and unconstrained branches do not have one safe inferred type.
  return types.size === 1 ? types.values().next().value : undefined;
}

type SchemaProfile = "strict" | "compat" | "openapi" | "moonshot";
const publishedNormalizations = createToolSchemaNormalizationCache<unknown>();

// Profiles retain their schema-slot scope, map-name handling and root promotion.
function normalizeToolSchemaRecursive(
  schema: unknown,
  profile: SchemaProfile | `${SchemaProfile}-map`,
  depth = 0,
  inferBranchType = false,
): unknown {
  const mapProfile =
    profile === "strict-map"
      ? "strict"
      : profile === "compat-map"
        ? "compat"
        : profile === "openapi-map"
          ? "openapi"
          : profile === "moonshot-map"
            ? "moonshot"
            : undefined;
  if (Array.isArray(schema)) {
    if (mapProfile) {
      return schema;
    }
    let changed = false;
    const normalized = schema.map((entry) => {
      const next = normalizeToolSchemaRecursive(
        entry,
        profile,
        profile === "strict" ? depth : 1,
        inferBranchType,
      );
      changed ||= next !== entry;
      return next;
    });
    return changed ? normalized : schema;
  }
  if (!isRecord(schema)) {
    return schema;
  }

  const record = schema;
  let changed = false;
  let hadNullType = false;
  const nullable = profile === "openapi" && record.nullable === true;
  const entries: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(record)) {
    // Repair only null-valued entries that carry no constraint semantics.
    // Null constraints stay invalid so projection quarantines the tool.
    if (
      profile === "compat" &&
      value === null &&
      (OPENAI_NULLABLE_ANNOTATION_KEYS.has(key) || key === "type")
    ) {
      hadNullType ||= key === "type";
      changed = true;
      continue;
    }
    if (profile === "openapi") {
      if (key === "nullable" || OPENAPI_SCHEMA_ANNOTATION_KEYS.has(key)) {
        changed = true;
        continue;
      }
      if (SCHEMA_LITERAL_KEYS.has(key) || key === "components") {
        entries.push([key, value]);
        continue;
      }
      let next = value;
      if (OPENAPI_MAP_KEYS.has(key) && isRecord(value)) {
        next = normalizeToolSchemaRecursive(value, "openapi-map", 1);
      } else if (OPENAPI_OBJECT_KEYS.has(key) && isRecord(value)) {
        next = normalizeToolSchemaRecursive(value, profile, 1);
      } else if (OPENAPI_ARRAY_KEYS.has(key) && Array.isArray(value)) {
        const nextEntries = value.map((entry) => normalizeToolSchemaRecursive(entry, profile, 1));
        // A changed sibling exposes copies even when this array's entries are unchanged.
        changed ||= nextEntries.some((entry, index) => entry !== value[index]);
        entries.push([key, nextEntries]);
        continue;
      }
      changed ||= next !== value;
      entries.push([key, next]);
      continue;
    }
    let next = value;
    if (profile === "strict") {
      if (SCHEMA_MAP_KEYS.has(key)) {
        next = normalizeToolSchemaRecursive(value, "strict-map", depth);
      } else if (SCHEMA_NESTED_KEYS.has(key)) {
        next = normalizeToolSchemaRecursive(value, profile, depth + 1);
      }
    } else if (mapProfile) {
      next = normalizeToolSchemaRecursive(
        value,
        mapProfile,
        profile === "strict-map" ? depth + 1 : 1,
      );
    } else if (SCHEMA_MAP_KEYS.has(key)) {
      next = normalizeToolSchemaRecursive(
        value,
        profile === "moonshot" ? "moonshot-map" : "compat-map",
        1,
      );
    } else if (SCHEMA_NESTED_KEYS.has(key)) {
      next = normalizeToolSchemaRecursive(
        value,
        profile === "moonshot" ? "moonshot" : "compat",
        1,
        profile === "moonshot" && (key === "anyOf" || key === "oneOf"),
      );
    }
    changed ||= next !== value;
    entries.push([key, next]);
  }
  // Schema names are literal data; indexed writes would invoke __proto__'s setter.
  const normalized = Object.fromEntries<unknown>(entries);

  if (mapProfile) {
    return changed ? normalized : schema;
  }

  if (profile === "moonshot") {
    if (inferBranchType && !("type" in normalized)) {
      const type = inferUnionBranchType(normalized);
      if (type) {
        normalized.type = type;
        changed = true;
      }
    }
    return changed ? normalized : schema;
  }

  if (profile === "openapi") {
    if (nullable) {
      if ([normalized.allOf, normalized.anyOf, normalized.oneOf].some(Array.isArray)) {
        if (
          (Array.isArray(normalized.anyOf) && normalized.anyOf.some(isNullSchemaLike)) ||
          (Array.isArray(normalized.oneOf) && normalized.oneOf.some(isNullSchemaLike))
        ) {
          return normalized;
        }
        const wrapped = { anyOf: [normalized, { type: "null" }] };
        copySchemaMeta(normalized, wrapped);
        return wrapped;
      }
      const type = normalized.type;
      if (typeof type === "string" && type !== "null") {
        normalized.type = [type, "null"];
      } else if (Array.isArray(type) && !type.includes("null")) {
        normalized.type = [...type, "null"];
      }
      if (Array.isArray(normalized.enum) && !normalized.enum.includes(null)) {
        normalized.enum = [...normalized.enum, null];
      }
    }
    return changed || nullable ? normalized : schema;
  }

  if (profile === "compat") {
    if (Object.keys(normalized).length === 0) {
      if (depth !== 0) {
        return schema;
      }
      return { type: "object", properties: {}, required: [], additionalProperties: false };
    }

    const hasObjectShapeHints =
      (normalized.properties &&
        typeof normalized.properties === "object" &&
        !Array.isArray(normalized.properties)) ||
      Array.isArray(normalized.required);
    const hasArrayShapeHints = "items" in normalized;
    if (!("type" in normalized) && hasObjectShapeHints !== hasArrayShapeHints) {
      normalized.type = hasObjectShapeHints ? "object" : "array";
      changed = true;
    } else if (hadNullType && !("type" in normalized)) {
      // Without an unambiguous shape, retain the invalid type so projection
      // rejects the tool instead of widening it to an unconstrained schema.
      normalized.type = null;
    }
    if (normalized.type === "object" && !("properties" in normalized)) {
      normalized.properties = {};
      changed = true;
    }
  }

  const hasEmptyProperties =
    isRecord(normalized.properties) && Object.keys(normalized.properties).length === 0;

  if (normalized.type === "object" && !Array.isArray(normalized.required) && hasEmptyProperties) {
    normalized.required = [];
    changed = true;
  }
  if (
    normalized.type === "object" &&
    (profile === "strict" ? depth === 0 : hasEmptyProperties) &&
    !("additionalProperties" in normalized)
  ) {
    normalized.additionalProperties = false;
    changed = true;
  }

  return changed ? normalized : schema;
}

export function normalizeToolSchema(
  schema: Record<string, unknown>,
  profile: "moonshot",
  toolName?: string,
): Record<string, unknown>;
export function normalizeToolSchema(
  schema: unknown,
  profile: "strict" | "compat" | "openapi",
  toolName?: string,
): unknown;
export function normalizeToolSchema(
  schema: unknown,
  profile: SchemaProfile,
  toolName?: string,
): unknown {
  const source =
    schema && typeof schema === "object" && getPublishedRuntimeToolInputSchema(schema)
      ? schema
      : undefined;
  if (source) {
    if (wasToolSchemaTruncated(source)) {
      reportToolSchemaTruncation(source, toolName);
    }
    const cached = publishedNormalizations.get(source, profile);
    if (cached !== undefined) {
      return cached;
    }
  }
  // Publication already bounded and detached the schema; mutable inputs still need admission.
  const bounded = source ?? truncateToolSchemaDepth(schema, toolName);
  const normalized = inheritToolSchemaTruncation(
    bounded,
    normalizeToolSchemaRecursive(bounded, profile),
  );
  return source ? publishedNormalizations.remember(source, profile, normalized) : normalized;
}
