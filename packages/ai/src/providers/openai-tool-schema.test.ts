import { deepStrictEqual } from "node:assert/strict";
import { describe, expect, it } from "vitest";
import { projectOpenAITools } from "./openai-tool-projection.js";
import { normalizeOpenAIStrictCompatSchema } from "./openai-tool-schema-compat.js";
import {
  findOpenAIStrictSchemaViolations,
  isStrictOpenAIJsonSchemaCompatible,
  normalizeStrictOpenAIJsonSchema,
  resolveOpenAIProjectedToolsStrictToolFlag,
} from "./openai-tool-schema.js";

function objectSchema(properties: Record<string, unknown> = {}) {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}
const valueObject = () => ({ type: "object", properties: { value: { type: "string" } } });
const literalArray = () => ({ ["__proto__"]: { type: "array" } });
const violations = (schema: unknown) =>
  findOpenAIStrictSchemaViolations(schema, "parameters", { requireObjectRoot: true });

describe("OpenAI strict tool schema normalization", () => {
  it("preserves literal names when repairing dependencies", () => {
    const schema = {
      type: "object",
      dependencies: { ["__proto__"]: { type: "string", description: null } },
    };

    const normalized = normalizeOpenAIStrictCompatSchema(schema);
    expect(Object.getOwnPropertyDescriptor(normalized, "dependencies")?.value).toStrictEqual({
      ["__proto__"]: { type: "string" },
    });
    expect(schema.dependencies).toStrictEqual({
      ["__proto__"]: { type: "string", description: null },
    });
  });

  it("infers the root type from schema fields instead of a literal prototype key", () => {
    const properties = { path: { type: "string" } };
    const schema = { ...literalArray(), properties, description: null };
    expect(normalizeOpenAIStrictCompatSchema(schema)).toStrictEqual({
      ...literalArray(),
      properties: { path: { type: "string" } },
      type: "object",
    });
  });

  it.each(["anyOf", "oneOf"])("preserves literal properties when flattening %s", (unionKey) => {
    const properties = {
      ["__proto__"]: { type: "string", minLength: 1 },
      constructor: { type: "integer" },
      toString: { type: "boolean" },
    };
    const required = ["__proto__", "constructor", "toString"];
    const schema = {
      [unionKey]: [
        { type: "object", properties, required },
        { type: "object", properties: { ["__proto__"]: { type: "string" } }, required },
      ],
      additionalProperties: false,
    };

    deepStrictEqual(normalizeStrictOpenAIJsonSchema(schema), objectSchema(properties));
    expect(isStrictOpenAIJsonSchemaCompatible(schema)).toBe(true);
  });

  it("preserves literal metadata when removing OpenAPI annotations", () => {
    const schema = { ...objectSchema(valueObject().properties), ...literalArray() };

    expect(normalizeStrictOpenAIJsonSchema({ ...schema, nullable: false })).toStrictEqual(schema);
  });

  it("repairs top-level object schemas with missing or invalid properties", () => {
    const schemas = [
      { type: "object" },
      ...[undefined, null, [], "invalid"].map((properties) => ({ type: "object", properties })),
    ];

    for (const schema of schemas) {
      expect(normalizeStrictOpenAIJsonSchema(schema)).toEqual(objectSchema());
      expect(isStrictOpenAIJsonSchemaCompatible(schema)).toBe(true);
    }
  });

  it("walks named schema maps without treating definition names as keywords", () => {
    const schema = {
      ...objectSchema(),
      $defs: { anyOf: { type: "string" } },
      examples: [{ anyOf: [{ type: "string" }] }],
    };

    expect(violations(schema)).toEqual([]);
    const projection = projectOpenAITools([{ name: "lookup", parameters: schema }]);
    expect(resolveOpenAIProjectedToolsStrictToolFlag(projection, true)).toBe(true);
  });

  it("walks legacy and content schema applicators", () => {
    const schema = {
      ...objectSchema(),
      dependencies: { mode: ["payload"], payload: valueObject() },
      additionalItems: valueObject(),
      contentSchema: valueObject(),
    };

    expect(violations(schema)).toEqual([
      "parameters.dependencies.payload.additionalProperties",
      "parameters.dependencies.payload.required",
      "parameters.additionalItems.additionalProperties",
      "parameters.additionalItems.required",
      "parameters.contentSchema.additionalProperties",
      "parameters.contentSchema.required",
    ]);
    expect(isStrictOpenAIJsonSchemaCompatible(schema)).toBe(false);
  });

  it.each(["^[a-z]+$", "\\(?=a"])("accepts non-lookaround pattern %s", (pattern) => {
    expect(findOpenAIStrictSchemaViolations({ type: "string", pattern }, "value")).toEqual([]);
  });
});
