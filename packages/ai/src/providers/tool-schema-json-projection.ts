import { types as utilTypes } from "node:util";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord as isJsonObject } from "@openclaw/normalization-core/record-coerce";

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

function serializeToolInputSchema(value: unknown, path: string): RuntimeToolInputSchemaProjection {
  const nonFiniteNumber = {
    path: null as string | null,
  };
  const ancestors: object[] = [];
  const pathLengths: number[] = [];
  const segments = [path];
  let isRoot = true;
  let text: string | undefined;
  try {
    text = JSON.stringify(value, function (this: object, key, entry) {
      const invalidNumber = nonFiniteNumber.path === null && isNonFiniteNumberValue(entry);
      if (invalidNumber || (entry && typeof entry === "object")) {
        // The replacer's holder identifies when native JSON traversal returns to a parent.
        // Keep only that ancestor path, including objects returned by toJSON.
        while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) {
          ancestors.pop();
          segments.length = expectDefined(pathLengths.pop(), "schema ancestor path length");
        }
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
          ancestors.push(entry);
          pathLengths.push(prefixLength);
        }
      }
      isRoot = false;
      return entry;
    });
  } catch {
    return {
      schema: {},
      violations: [`${path} is not JSON-serializable`],
    };
  }
  if (!text) {
    return {
      schema: {},
      violations: [`${path} is not JSON-serializable`],
    };
  }
  if (nonFiniteNumber.path !== null) {
    const violationPath = nonFiniteNumber.path;
    return {
      schema: {},
      violations: [`${violationPath} is not JSON-serializable`],
    };
  }
  return {
    schema: JSON.parse(text) as RuntimeToolInputSchemaJson,
    violations: [],
  };
}

const schemaMapKeywords = new Set([
  "$defs",
  "definitions",
  "dependencies",
  "dependentSchemas",
  "patternProperties",
  "properties",
]);

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
  for (const key of Object.keys(schema)) {
    const value = schema[key];
    if (typeof value === "number" && !Number.isFinite(value)) {
      return false;
    }
    if (!value || typeof value !== "object") {
      continue;
    }
    path.push(".", key);
    if (schemaMapKeywords.has(key) && isJsonObject(value)) {
      for (const schemaName of Object.keys(value)) {
        const childSchema = value[schemaName];
        if (childSchema === undefined) {
          return false;
        }
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
): RuntimeToolInputSchemaProjection {
  const projection = serializeToolInputSchema(schema, path);
  const violations = [...projection.violations];
  if (!isJsonObject(projection.schema)) {
    violations.push(`${path} must be a JSON object schema`);
  } else if (projection.schema.type !== undefined && projection.schema.type !== "object") {
    violations.push(`${path}.type must be "object"`);
  }
  // Valid schemas need no diagnostic strings; reuse this call's path while walking the JSON copy.
  if (!inspectJsonSchema(projection.schema, [path], violations)) {
    return { schema: {}, violations: [`${path} is not a JSON value`] };
  }
  return {
    schema: projection.schema,
    violations,
  };
}
