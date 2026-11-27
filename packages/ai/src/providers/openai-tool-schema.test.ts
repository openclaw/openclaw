import { deepStrictEqual } from "node:assert/strict";
import { describe, expect, it } from "vitest";
import { normalizeOpenAIStrictCompatSchema } from "./openai-tool-schema-compat.js";
import {
  findOpenAIStrictSchemaViolations,
  isStrictOpenAIJsonSchemaCompatible,
  normalizeStrictOpenAIJsonSchema,
  resolveOpenAIToolStrictFlag,
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
  const pathProperties = { path: { type: "string" } };
  it.each([
    [
      normalizeOpenAIStrictCompatSchema,
      { type: "object", dependencies: { ["__proto__"]: { type: "string", description: null } } },
      { ...objectSchema(), dependencies: { ["__proto__"]: { type: "string" } } },
    ],
    [
      normalizeOpenAIStrictCompatSchema,
      { ...literalArray(), properties: pathProperties, description: null },
      { ...literalArray(), properties: pathProperties, type: "object" },
    ],
    [
      normalizeStrictOpenAIJsonSchema,
      { ...objectSchema(valueObject().properties), ...literalArray(), nullable: false },
      { ...objectSchema(valueObject().properties), ...literalArray() },
    ],
  ] as const)("preserves literal keys during normalization %#", (normalize, schema, expected) => {
    const before = structuredClone(schema);
    expect(normalize(schema)).toStrictEqual(expected);
    expect(schema).toStrictEqual(before);
  });

  it.each(["anyOf", "oneOf"])("preserves literal properties when flattening %s", (unionKey) => {
    const properties = {
      ["__proto__"]: { type: "string", minLength: 1 },
      constructor: { type: "integer" },
      toString: { type: "boolean" },
    };
    const required = Object.keys(properties);
    const schema = {
      [unionKey]: [
        { type: "object", properties, required },
        { type: "object", properties: { ["__proto__"]: { type: "string" } }, required },
      ],
      additionalProperties: false,
    };

    deepStrictEqual(normalizeStrictOpenAIJsonSchema(schema), objectSchema(properties));
  });

  it.each([{ type: "object" }, { type: "object", properties: [] }])(
    "repairs object properties: %j",
    (schema) => {
      expect(normalizeStrictOpenAIJsonSchema(schema)).toEqual(objectSchema());
    },
  );

  it("walks named schema maps without treating definition names as keywords", () => {
    const schema = {
      ...objectSchema(),
      $defs: { anyOf: { type: "string" } },
      examples: [{ anyOf: [{ type: "string" }] }],
    };

    expect(violations(schema)).toEqual([]);
    expect(resolveOpenAIToolStrictFlag(schema, true)).toBe(true);
  });

  it("walks legacy and content schema applicators", () => {
    const schema = {
      ...objectSchema(),
      dependencies: { mode: ["payload"], payload: valueObject() },
      additionalItems: valueObject(),
      contentSchema: valueObject(),
    };

    expect(violations(schema)).toEqual(
      ["dependencies.payload", "additionalItems", "contentSchema"].flatMap((path) =>
        ["additionalProperties", "required"].map((key) => `parameters.${path}.${key}`),
      ),
    );
    expect(isStrictOpenAIJsonSchemaCompatible(schema)).toBe(false);
  });

  it.each(["^[a-z]+$", "\\(?=a"])("accepts non-lookaround pattern %s", (pattern) => {
    expect(findOpenAIStrictSchemaViolations({ type: "string", pattern }, "value")).toEqual([]);
  });

  // OpenAI rejected dispatch_action with "additionalProperties must be false" at args/type/0.
  it("holds a nullable object key to the object rules", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["args"],
      properties: { args: { type: ["object", "null"], patternProperties: { "^.*$": {} } } },
    };
    expect(findOpenAIStrictSchemaViolations(schema, "parameters")).toContain(
      "parameters.properties.args.additionalProperties",
    );
  });

  // Strict is decided per tool on the schema as written; optional keys are never projected.
  it("keeps a tool with optional keys non-strict and its schema unchanged", () => {
    const schema = {
      type: "object",
      properties: { path: { type: "string" }, limit: { type: "number" } },
      required: ["path"],
      additionalProperties: false,
    };
    expect(resolveOpenAIToolStrictFlag(schema, true)).toBe(false);
    expect(resolveOpenAIToolStrictFlag(objectSchema({ path: { type: "string" } }), true)).toBe(
      true,
    );
  });

  // Strict normalization would close an open root and drop the extra arguments it allows.
  it("keeps a tool with an open root non-strict", () => {
    const open = { type: "object", properties: { q: { type: "string" } }, required: ["q"] };
    expect(resolveOpenAIToolStrictFlag(open, true)).toBe(false);
    expect(resolveOpenAIToolStrictFlag({ ...open, additionalProperties: false }, true)).toBe(true);
  });

  // A union branch without a type is valid JSON Schema but outside strict mode's subset.
  it("keeps a closed tool with a union key non-strict, but accepts a nullable type list", () => {
    const union = objectSchema({ mode: { anyOf: [{ enum: ["auto"] }, { type: "integer" }] } });
    expect(resolveOpenAIToolStrictFlag(union, true)).toBe(false);
    expect(resolveOpenAIToolStrictFlag(objectSchema({ value: {} }), true)).toBe(false);
    const nullable = objectSchema({ limit: { type: ["integer", "null"] } });
    expect(resolveOpenAIToolStrictFlag(nullable, true)).toBe(true);
  });
});
