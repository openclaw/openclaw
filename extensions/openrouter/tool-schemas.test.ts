import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { Check } from "typebox/schema";
import { beforeAll, describe, expect, it } from "vitest";
import openrouterPlugin from "./index.js";

let provider: Awaited<ReturnType<typeof registerSingleProviderPlugin>>;
beforeAll(async () => {
  provider = await registerSingleProviderPlugin(openrouterPlugin);
});

function normalize(
  schema: Record<string, unknown>,
  modelId = "openrouter/moonshotai/kimi-example",
) {
  const tool: AnyAgentTool = {
    name: "example_lookup",
    label: "Example lookup",
    description: "Return the supplied value.",
    parameters: schema,
    execute: async () => ({ content: [], details: {} }),
  };
  const context = {
    provider: "openrouter",
    modelId,
    modelApi: "openai-completions",
    tools: [tool],
  };
  const tools = provider.normalizeToolSchemas?.(context);
  expect(tools).toHaveLength(1);
  expect(tools?.[0]?.execute).toBe(tool.execute);
  const normalizedTool = tools?.[0];
  if (!normalizedTool) {
    throw new Error("normalized tool missing");
  }
  return normalizedTool.parameters as Record<string, unknown>;
}

describe("OpenRouter tool schemas", () => {
  it.each([
    "moonshotai/kimi-example",
    "moonshot/kimi-example",
    "openrouter/moonshotai/kimi-example",
  ])("preserves meaningful union alternatives for %s", (modelId) => {
    const schema = {
      type: "object",
      properties: {
        value: {
          anyOf: [
            { type: "string", minLength: 2 },
            { type: "integer", minimum: 3 },
          ],
        },
        optional: { oneOf: [{ type: "string" }, { type: "null" }] },
      },
      required: ["value"],
      additionalProperties: false,
    };
    const original = structuredClone(schema);
    const result = normalize(schema, modelId);
    expect(result).toEqual(schema);
    expect(schema).toEqual(original);
    for (const value of [{ value: "ok" }, { value: 3 }, { value: 3, optional: null }]) {
      expect(Check(result, value)).toBe(true);
    }
    for (const value of [{ value: "x" }, { value: 2 }, { value: true }, { value: 3, extra: 1 }]) {
      expect(Check(result, value)).toBe(false);
    }
  });

  it.each([
    "moonshotai/kimi-example",
    "~moonshotai/kimi-example",
    "openrouter/~moonshotai/kimi-example",
  ])("moves a parent type without losing constraints for %s", (modelId) => {
    const value = { type: "string", maxLength: 4, anyOf: [{ enum: ["red"] }, { const: "blue" }] };
    const schema = { type: "object", properties: { value }, required: ["value"] };
    const result = normalize(schema, modelId);
    expect(result).toEqual({
      ...schema,
      properties: {
        value: {
          maxLength: 4,
          anyOf: [
            { type: "string", enum: ["red"] },
            { type: "string", const: "blue" },
          ],
        },
      },
    });
    for (const sample of ["red", "blue", "green", "", 3, null]) {
      expect(Check(result, { value: sample })).toBe(Check(schema, { value: sample }));
    }
    expect(schema.properties.value).toBe(value);
    expect(value.type).toBe("string");
  });

  it.each([
    { type: ["string", "null"], anyOf: [{ const: "red" }, { const: null }] },
    { type: "number", minimum: 2, anyOf: [{ type: "integer", maximum: 3 }, { const: 4.5 }] },
    {
      type: "object",
      additionalProperties: false,
      properties: { a: {}, b: {} },
      anyOf: [{ required: ["a"] }, { required: ["b"] }],
    },
  ])("preserves acceptance for nullable, numeric and object constraints: %j", (value) => {
    const schema = { type: "object", properties: { value }, required: ["value"] };
    const result = normalize(schema);
    expect(result.properties).not.toEqual(schema.properties);
    for (const sample of [
      "red",
      "blue",
      null,
      1,
      2,
      3,
      4,
      4.5,
      true,
      {},
      { a: 1 },
      { b: 2 },
      { c: 3 },
    ]) {
      expect(Check(result, { value: sample }), JSON.stringify(sample)).toBe(
        Check(schema, { value: sample }),
      );
    }
  });

  it.each([
    { type: "string", anyOf: [{ type: "string" }, { type: "integer" }] },
    { type: "integer", anyOf: [{ type: "number" }] },
    { type: "string", anyOf: [true, { const: "red" }] },
    { type: "string", anyOf: [false, { const: "red" }] },
    { type: "string", anyOf: [{ $ref: "#/$defs/value" }] },
    { type: "string", anyOf: [{ anyOf: [{ const: "red" }, { const: "blue" }] }] },
    { type: "string", anyOf: [{ oneOf: [{ const: "red" }, { const: "blue" }] }] },
    { type: "string", oneOf: [{ const: "red" }, { const: "blue" }] },
    { type: "string", anyOf: [] },
    { type: "future", anyOf: [{ const: "red" }] },
    { type: "string", anyOf: [{ type: [] }] },
  ])("leaves unevidenced or incompatible unions intact: %j", (value) => {
    const schema = { type: "object", properties: { value } };
    expect(normalize(schema)).toEqual(schema);
  });

  it("walks schema locations without interpreting annotation objects or special property names", () => {
    const union = { type: "string", anyOf: [{ const: "red" }, { const: "blue" }] };
    const typed = {
      anyOf: [
        { type: "string", const: "red" },
        { type: "string", const: "blue" },
      ],
    };
    const schema = {
      type: "object",
      properties: Object.fromEntries([
        ["__proto__", union],
        ["anyOf", { type: "array", items: union }],
      ]),
      $defs: { value: union },
      dependencies: { dependent: union, list: ["first", "second"] },
      default: { value: union },
      examples: [{ value: union }],
    };
    const result = normalize(schema);
    expect(result).toEqual({
      ...schema,
      properties: Object.fromEntries([
        ["__proto__", typed],
        ["anyOf", { type: "array", items: typed }],
      ]),
      $defs: { value: typed },
      dependencies: { dependent: typed, list: ["first", "second"] },
    });
    expect(Object.hasOwn(result.properties as object, "__proto__")).toBe(true);
    expect(normalize(result)).toEqual(result);
  });

  it.each([
    "deepseek/example",
    "openrouter/deepseek/example",
    "openrouter/deepseek-v4-flash",
    "~deepseek/example",
    "openrouter/~deepseek/example",
    "google/example",
    "openrouter/google/example",
    "~google/example",
    "openrouter/~google/example",
  ])("preserves existing OpenRouter schemas for %s", (modelId) => {
    const schema = {
      type: "object",
      properties: { value: { anyOf: [{ type: "string" }, { type: "integer" }] } },
      additionalProperties: false,
    };
    const result = normalize(schema, modelId);
    expect(result).toBe(schema);
    expect(Check(result, { value: "ok" })).toBe(true);
    expect(Check(result, { value: 3 })).toBe(true);
    expect(
      provider.inspectToolSchemas?.({
        provider: "openrouter",
        modelId,
        tools: [
          {
            name: "example",
            label: "Example",
            description: "Example",
            parameters: schema,
            execute: async () => ({ content: [], details: {} }),
          },
        ],
      }),
    ).toEqual([]);
  });

  it.each(["openai/example", "anthropic/example", "unknown/example", "openrouter/auto"])(
    "keeps non-target family schemas intact for %s",
    (modelId) => {
      const schema = {
        type: "object",
        properties: { value: { anyOf: [{ type: "string" }, { type: "integer" }] } },
      };
      expect(normalize(schema, modelId)).toBe(schema);
      expect(provider.inspectToolSchemas?.({ provider: "openrouter", modelId, tools: [] })).toEqual(
        [],
      );
    },
  );
});
