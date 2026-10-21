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

const emptyObject = {
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
};
const valueObject = { type: "object", properties: { value: { type: "string" } } };

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
    const schema = {
      ["__proto__"]: { type: "array" },
      properties: { path: { type: "string" } },
      description: null,
    };

    expect(normalizeOpenAIStrictCompatSchema(schema)).toStrictEqual({
      ["__proto__"]: { type: "array" },
      properties: { path: { type: "string" } },
      type: "object",
    });
  });

  it.each(["anyOf", "oneOf"])(
    "preserves variant-only literal properties when flattening %s",
    (unionKey) => {
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

      deepStrictEqual(normalizeStrictOpenAIJsonSchema(schema), {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      });
      expect(isStrictOpenAIJsonSchemaCompatible(schema)).toBe(true);
    },
  );

  it("preserves literal metadata when removing OpenAPI annotations", () => {
    const schema = {
      ...valueObject,
      required: ["value"],
      additionalProperties: false,
      ["__proto__"]: { type: "array" },
    };

    expect(normalizeStrictOpenAIJsonSchema({ ...schema, nullable: false })).toStrictEqual(schema);
  });

  it("repairs top-level object schemas with missing or invalid properties", () => {
    const schemas = [
      { type: "object" },
      { type: "object", properties: undefined },
      { type: "object", properties: null },
      { type: "object", properties: [] },
      { type: "object", properties: "invalid" },
    ];

    for (const schema of schemas) {
      expect(normalizeStrictOpenAIJsonSchema(schema)).toEqual(emptyObject);
      expect(isStrictOpenAIJsonSchemaCompatible(schema)).toBe(true);
    }
  });

  it("walks named schema maps without treating definition names as keywords", () => {
    const schema = {
      ...emptyObject,
      $defs: { anyOf: { type: "string" } },
      examples: [{ anyOf: [{ type: "string" }] }],
    };

    expect(
      findOpenAIStrictSchemaViolations(schema, "parameters", { requireObjectRoot: true }),
    ).toEqual([]);
    expect(
      resolveOpenAIProjectedToolsStrictToolFlag(
        projectOpenAITools([{ name: "lookup", parameters: schema }]),
        true,
      ),
    ).toBe(true);
  });

  it("walks legacy and content schema applicators", () => {
    const schema = {
      ...emptyObject,
      dependencies: { mode: ["payload"], payload: valueObject },
      additionalItems: valueObject,
      contentSchema: valueObject,
    };

    expect(
      findOpenAIStrictSchemaViolations(schema, "parameters", { requireObjectRoot: true }),
    ).toEqual([
      "parameters.dependencies.payload.additionalProperties",
      "parameters.dependencies.payload.required",
      "parameters.additionalItems.additionalProperties",
      "parameters.additionalItems.required",
      "parameters.contentSchema.additionalProperties",
      "parameters.contentSchema.required",
    ]);
    expect(isStrictOpenAIJsonSchemaCompatible(schema)).toBe(false);
  });

  it.each(["^[a-z]+$", "\\(?=a"])(
    "keeps strict mode for pattern %s without a lookaround",
    (pattern) => {
      expect(findOpenAIStrictSchemaViolations({ type: "string", pattern }, "value")).toEqual([]);
    },
  );
});
