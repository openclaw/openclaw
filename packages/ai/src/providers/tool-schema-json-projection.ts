import { types as utilTypes } from "node:util";
import { isRecord as isJsonObject } from "@openclaw/normalization-core/record-coerce";
import { SCHEMA_MAP_KEYS } from "./schema-walk.js";
import {
  MAX_TOOL_SCHEMA_DEPTH,
  inheritToolSchemaTruncation,
  reportToolSchemaTruncation,
  toolSchemaChildPosition,
  wasToolSchemaTruncated,
  type ToolSchemaPosition,
} from "./tool-schema-depth.js";
import type { PreparedToolSchemaNormalization } from "./tool-schema-normalization-cache.js";

/** JSON-safe schema value used when projecting runtime tool parameters. */
export type RuntimeToolInputSchemaJson =
  | null
  | boolean
  | number
  | string
  | RuntimeToolInputSchemaJson[]
  | { [key: string]: RuntimeToolInputSchemaJson };

/** Projected runtime tool schema plus validation violations. */
export type RuntimeToolInputSchemaProjection = {
  readonly schema: RuntimeToolInputSchemaJson;
  readonly violations: readonly string[];
};

function isNonFiniteNumberValue(value: unknown): boolean {
  if (typeof value === "number") {
    return !Number.isFinite(value);
  }
  if (value === null || typeof value !== "object" || !utilTypes.isNumberObject(value)) {
    return false;
  }
  return !Number.isFinite(Number.prototype.valueOf.call(value));
}

function projectToolInputSchema(
  value: unknown,
  path: string,
  captureJson?: (text: string) => void,
  toolName?: string,
): RuntimeToolInputSchemaProjection {
  const nonFiniteNumber = {
    path: null as string | null,
  };
  const ancestors: Array<{
    value: object;
    pathLength: number;
    position: ToolSchemaPosition | undefined;
  }> = [];
  const segments = [path];
  let isRoot = true;
  let truncated = false;
  let text: string | undefined;
  try {
    text = JSON.stringify(value, function (this: object, key, sourceEntry) {
      let entry = sourceEntry;
      // Native serialization owns getter/toJSON evaluation; classify only the value it produced.
      while (ancestors.length > 0 && ancestors[ancestors.length - 1]?.value !== this) {
        const parent = ancestors.pop();
        if (parent) {
          segments.length = parent.pathLength;
        }
      }
      const position: ToolSchemaPosition | undefined = isRoot
        ? { kind: "schema", depth: 0 }
        : toolSchemaChildPosition(ancestors[ancestors.length - 1]?.position, this, key, entry);
      if (position?.kind === "schema" && wasToolSchemaTruncated(entry)) {
        truncated = true;
      }
      if (position?.kind === "schema" && position.depth > MAX_TOOL_SCHEMA_DEPTH) {
        truncated = true;
        entry = {};
      }
      const invalidNumber = nonFiniteNumber.path === null && isNonFiniteNumberValue(entry);
      if (invalidNumber || (entry && typeof entry === "object")) {
        const prefixLength = segments.length;
        if (!isRoot) {
          if (Array.isArray(this)) {
            segments.push("[", key, "]");
          } else {
            segments.push(".", key);
          }
        }
        if (invalidNumber) {
          nonFiniteNumber.path = segments.join("");
          segments.length = prefixLength;
        } else {
          ancestors.push({ value: entry, pathLength: prefixLength, position });
        }
      }
      isRoot = false;
      return entry;
    });
  } catch {
    // A stringify failure reports the root even if an earlier entry was non-finite.
  }
  if (!text || nonFiniteNumber.path !== null) {
    const violationPath = text ? nonFiniteNumber.path : path;
    return {
      schema: {},
      violations: [`${violationPath} is not JSON-serializable`],
    };
  }
  if (truncated) {
    reportToolSchemaTruncation(value, toolName);
  }
  const schema = inheritToolSchemaTruncation(
    undefined,
    JSON.parse(text) as RuntimeToolInputSchemaJson,
    truncated,
  );
  captureJson?.(text);
  const violations: string[] = [];
  if (!isJsonObject(schema)) {
    violations.push(`${path} must be a JSON object schema`);
  } else if (schema.type !== undefined && schema.type !== "object") {
    violations.push(`${path}.type must be "object"`);
  }
  // Valid schemas need no diagnostic strings; reuse this call's path while walking the JSON copy.
  if (!inspectJsonSchema(schema, [path], violations)) {
    return { schema: {}, violations: [`${path} is not a JSON value`] };
  }
  return {
    schema,
    violations,
  };
}

function inspectJsonSchema(
  schema: RuntimeToolInputSchemaJson,
  path: (string | number)[],
  violations: string[],
): boolean {
  if (Array.isArray(schema)) {
    let index = 0;
    for (const entry of schema) {
      path.push("[", index++, "]");
      const valid = inspectJsonSchema(entry, path, violations);
      path.length -= 3;
      if (!valid) {
        return false;
      }
    }
    return true;
  }
  if (!isJsonObject(schema)) {
    // Raw JSON numeric literals can overflow during parsing without passing
    // through the stringify replacer's non-finite number check.
    return typeof schema !== "number" || Number.isFinite(schema);
  }
  for (const key of ["$dynamicRef", "$dynamicAnchor"] as const) {
    if (key in schema) {
      violations.push(`${path.join("")}.${key}`);
    }
  }
  for (const [key, value] of Object.entries(schema)) {
    if (typeof value === "number" && !Number.isFinite(value)) {
      return false;
    }
    if (!value || typeof value !== "object") {
      continue;
    }
    path.push(".", key);
    if (SCHEMA_MAP_KEYS.has(key) && isJsonObject(value)) {
      for (const [schemaName, childSchema] of Object.entries(value)) {
        path.push(".", schemaName);
        const valid = inspectJsonSchema(childSchema, path, violations);
        path.length -= 2;
        if (!valid) {
          return false;
        }
      }
    } else if (!inspectJsonSchema(value, path, violations)) {
      return false;
    }
    path.length -= 2;
  }
  return true;
}

/** Projects one runtime tool input schema to JSON and reports runtime incompatibilities. */
export function projectRuntimeToolInputSchema(
  schema: unknown,
  path = "parameters",
  toolName?: string,
): RuntimeToolInputSchemaProjection {
  return projectToolInputSchema(schema, path, undefined, toolName);
}

/** Package-private preparation; public projections never carry normalization provenance. */
export function prepareRuntimeToolInputSchema(
  schema: unknown,
  path: string,
  toolName?: string,
): {
  projection: RuntimeToolInputSchemaProjection;
  normalization?: PreparedToolSchemaNormalization;
} {
  let inputJson: string | undefined;
  const projection = projectToolInputSchema(
    schema,
    path,
    (text) => {
      inputJson = text;
    },
    toolName,
  );
  return {
    projection,
    ...(schema && typeof schema === "object" && inputJson && projection.violations.length === 0
      ? { normalization: { source: schema, inputJson } }
      : {}),
  };
}
