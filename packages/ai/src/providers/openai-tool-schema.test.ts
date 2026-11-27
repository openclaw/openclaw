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
    // Nested objects that only list properties stay open, so this tool goes non-strict.
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

  // The strict projection never narrows: a tool it cannot project exactly goes non-strict.
  it.each([
    [
      "an open nested object",
      objectSchema({ options: { type: "object", properties: { known: { type: "string" } } } }),
    ],
    [
      "an optional key that already accepts null (null would clear, not omit)",
      {
        type: "object",
        properties: { title: { type: "string" }, assignee: { type: ["string", "null"] } },
        required: ["title"],
        additionalProperties: false,
      },
    ],
    [
      "optional keys beside a key-count constraint",
      {
        type: "object",
        properties: { a: { type: "string" }, b: { type: "string" } },
        required: [],
        additionalProperties: false,
        maxProperties: 1,
      },
    ],
    [
      "optional keys inside a union of arrays",
      objectSchema({
        tags: {
          anyOf: [
            {
              type: "array",
              items: {
                type: "object",
                properties: { name: { type: "string" }, note: { type: "string" } },
                required: ["name"],
                additionalProperties: false,
              },
            },
            { type: "null" },
          ],
        },
      }),
    ],
  ])("sends a tool with %s non-strict", (_name, schema) => {
    expect(resolveOpenAIToolStrictFlag(schema, true)).toBe(false);
  });

  it("keeps an optional untyped enum omittable under strict", () => {
    const schema = {
      type: "object",
      properties: { mode: { enum: ["image", "file"] } },
      required: [],
    };
    expect(normalizeStrictOpenAIJsonSchema(schema)).toMatchObject({
      required: ["mode"],
      properties: { mode: { enum: ["image", "file", null] } },
    });
  });

  it("keeps an optional union with a sibling type omittable under strict", () => {
    const mode = { type: "string", anyOf: [{ enum: ["auto", "manual"] }] };
    const schema = { type: "object", properties: { mode }, required: [] };
    expect(normalizeStrictOpenAIJsonSchema(schema)).toMatchObject({
      required: ["mode"],
      properties: { mode: { anyOf: [mode, { type: "null" }] } },
    });
  });

  it("adds null to an enum that a nullable type would still reject", () => {
    const schema = {
      type: "object",
      properties: { mode: { type: ["string", "null"], enum: ["auto", "manual"] } },
      required: [],
    };
    expect(normalizeStrictOpenAIJsonSchema(schema)).toMatchObject({
      required: ["mode"],
      properties: { mode: { type: ["string", "null"], enum: ["auto", "manual", null] } },
    });
  });
});
