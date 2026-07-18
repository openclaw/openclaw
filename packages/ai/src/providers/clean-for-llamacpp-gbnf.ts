/**
 * llama.cpp grammar-constrained tool calling rejects several JSON Schema
 * constructs that other providers accept. Strip them at the provider boundary so
 * canonical tool definitions keep their validation guidance intact.
 */
import type { TSchema } from "typebox";

/** Model compat profile id for opt-in llama.cpp GBNF tool-schema cleaning. */
export const LLAMACPP_TOOL_SCHEMA_PROFILE = "llamacpp";

// llama.cpp compiles bounded maxLength into repeated grammar rules and caps the
// repetition count near 2000; larger values fail GBNF compilation (#108580).
const LLAMACPP_GBNF_MAX_REPETITION_THRESHOLD = 2000;

const SCHEMA_MAP_KEYS = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
]);

const SCHEMA_CHILD_KEYS = new Set([
  "items",
  "prefixItems",
  "additionalItems",
  "additionalProperties",
  "contains",
  "propertyNames",
  "not",
  "if",
  "then",
  "else",
  "unevaluatedItems",
  "unevaluatedProperties",
  "anyOf",
  "oneOf",
  "allOf",
]);

function cleanLlamacppGbnfNode(node: unknown): unknown {
  if (!node || typeof node !== "object") {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map((entry) => cleanLlamacppGbnfNode(entry));
  }

  const record = node as Record<string, unknown>;
  const cleaned: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(record)) {
    if (key === "pattern") {
      continue;
    }
    if (
      key === "maxLength" &&
      typeof value === "number" &&
      value > LLAMACPP_GBNF_MAX_REPETITION_THRESHOLD
    ) {
      continue;
    }

    if (SCHEMA_MAP_KEYS.has(key)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        cleaned[key] = Object.fromEntries(
          Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
            childKey,
            cleanLlamacppGbnfNode(childValue),
          ]),
        );
      }
      continue;
    }

    if (SCHEMA_CHILD_KEYS.has(key)) {
      if (Array.isArray(value)) {
        cleaned[key] = value.map((entry) => cleanLlamacppGbnfNode(entry));
      } else {
        cleaned[key] = cleanLlamacppGbnfNode(value);
      }
      continue;
    }

    cleaned[key] = value;
  }

  return cleaned;
}

function collectLlamacppGbnfViolations(node: unknown, path: string, out: string[]): void {
  if (!node || typeof node !== "object") {
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((entry, index) => collectLlamacppGbnfViolations(entry, `${path}[${index}]`, out));
    return;
  }

  const record = node as Record<string, unknown>;
  if (typeof record.pattern === "string") {
    out.push(`${path}.pattern`);
  }
  if (
    typeof record.maxLength === "number" &&
    record.maxLength > LLAMACPP_GBNF_MAX_REPETITION_THRESHOLD
  ) {
    out.push(`${path}.maxLength`);
  }

  for (const [key, value] of Object.entries(record)) {
    if (SCHEMA_MAP_KEYS.has(key)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
          collectLlamacppGbnfViolations(childValue, `${path}.${key}.${childKey}`, out);
        }
      }
      continue;
    }
    if (SCHEMA_CHILD_KEYS.has(key)) {
      collectLlamacppGbnfViolations(value, `${path}.${key}`, out);
    }
  }
}

/** Remove llama.cpp GBNF-incompatible pattern and oversized maxLength constraints. */
export function cleanSchemaForLlamacppGbnf(schema: unknown): TSchema {
  return cleanLlamacppGbnfNode(schema) as TSchema;
}

/** Report nested schema paths that llama.cpp GBNF conversion rejects. */
export function findLlamacppGbnfSchemaViolations(schema: unknown, path: string): string[] {
  const violations: string[] = [];
  collectLlamacppGbnfViolations(schema, path, violations);
  return violations;
}
