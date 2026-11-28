import { describe, expect, it } from "vitest";
import { normalizeOpenAIStrictCompatSchema } from "./openai-tool-schema-compat.js";
import { findOpenAIStrictSchemaViolations } from "./openai-tool-schema.js";

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

describe("OpenAI strict tool schema detection", () => {
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
  ] as const)("preserves literal keys during normalization %#", (normalize, schema, expected) => {
    const before = structuredClone(schema);
    expect(normalize(schema)).toStrictEqual(expected);
    expect(schema).toStrictEqual(before);
  });

  it("walks named schema maps without treating definition names as keywords", () => {
    const schema = {
      ...objectSchema(),
      $defs: { anyOf: { type: "string" } },
      examples: [{ anyOf: [{ type: "string" }] }],
    };

    expect(violations(schema)).toEqual([]);
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

  it("rejects optional keys, an open root, union keys and untyped values", () => {
    const optional = {
      type: "object",
      properties: { path: { type: "string" }, limit: { type: "number" } },
      required: ["path"],
      additionalProperties: false,
    };
    expect(violations(optional)).not.toEqual([]);
    expect(violations(objectSchema({ path: { type: "string" } }))).toEqual([]);
    const open = { type: "object", properties: { q: { type: "string" } }, required: ["q"] };
    expect(violations(open)).not.toEqual([]);
    const union = objectSchema({ mode: { anyOf: [{ enum: ["auto"] }, { type: "integer" }] } });
    expect(violations(union)).not.toEqual([]);
    expect(violations(objectSchema({ value: {} }))).not.toEqual([]);
    expect(violations(objectSchema({ limit: { type: ["integer", "null"] } }))).toEqual([]);
  });
});
