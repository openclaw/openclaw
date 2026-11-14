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
});
