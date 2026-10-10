import { isRecord as isSchemaRecord } from "@openclaw/normalization-core/record-coerce";
import { SCHEMA_MAP_KEYS } from "./tool-schema-refs.js";

/** llama.cpp rejects grammar repetitions whose expanded rule count reaches 2000. */
export const LLAMACPP_GBNF_MAX_REPETITION_THRESHOLD = 2000;

const SCHEMA_CHILD_KEYS = new Set([
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

/** Removes JSON Schema constraints that llama.cpp cannot compile into GBNF. */
export function cleanSchemaForLlamacppGbnf(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    let changed = false;
    const entries = schema.map((entry) => {
      const next = cleanSchemaForLlamacppGbnf(entry);
      changed ||= next !== entry;
      return next;
    });
    return changed ? entries : schema;
  }
  if (!isSchemaRecord(schema)) {
    return schema;
  }

  let changed = false;
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "pattern") {
      changed = true;
      continue;
    }
    if (
      key === "maxLength" &&
      typeof value === "number" &&
      value >= LLAMACPP_GBNF_MAX_REPETITION_THRESHOLD
    ) {
      changed = true;
      continue;
    }

    let next = value;
    if (SCHEMA_MAP_KEYS.has(key) && isSchemaRecord(value)) {
      let mapChanged = false;
      next = Object.fromEntries(
        Object.entries(value).map(([childKey, childValue]) => {
          const cleanedChild = cleanSchemaForLlamacppGbnf(childValue);
          mapChanged ||= cleanedChild !== childValue;
          return [childKey, cleanedChild];
        }),
      );
      if (!mapChanged) {
        next = value;
      }
    } else if (SCHEMA_CHILD_KEYS.has(key)) {
      next = cleanSchemaForLlamacppGbnf(value);
    }
    cleaned[key] = next;
    changed ||= next !== value;
  }
  return changed ? cleaned : schema;
}

function collectSchemaViolations(node: unknown, path: string, violations: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((entry, index) => collectSchemaViolations(entry, `${path}[${index}]`, violations));
    return;
  }
  if (!isSchemaRecord(node)) {
    return;
  }

  if ("pattern" in node) {
    violations.push(`${path}.pattern`);
  }
  if (
    typeof node.maxLength === "number" &&
    node.maxLength >= LLAMACPP_GBNF_MAX_REPETITION_THRESHOLD
  ) {
    violations.push(`${path}.maxLength`);
  }

  for (const [key, value] of Object.entries(node)) {
    if (SCHEMA_MAP_KEYS.has(key) && isSchemaRecord(value)) {
      for (const [childKey, childValue] of Object.entries(value)) {
        collectSchemaViolations(childValue, `${path}.${key}.${childKey}`, violations);
      }
    } else if (SCHEMA_CHILD_KEYS.has(key)) {
      collectSchemaViolations(value, `${path}.${key}`, violations);
    }
  }
}

/** Reports schema paths that llama.cpp cannot compile into GBNF. */
export function findLlamacppGbnfSchemaViolations(schema: unknown, path: string): string[] {
  const violations: string[] = [];
  collectSchemaViolations(schema, path, violations);
  return violations;
}
