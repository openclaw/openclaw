import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { Check } from "typebox/schema";
import { beforeAll, expect, it } from "vitest";
import openrouterPlugin from "./index.js";

let provider: Awaited<ReturnType<typeof registerSingleProviderPlugin>>;
beforeAll(async () => {
  provider = await registerSingleProviderPlugin(openrouterPlugin);
});

function createTool(schema: Record<string, unknown>): AnyAgentTool {
  return {
    name: "example_lookup",
    label: "Example lookup",
    description: "Return the supplied value.",
    parameters: schema,
    execute: async () => ({ content: [], details: {} }),
  };
}

function normalize(schema: Record<string, unknown>, modelId = "openrouter/moonshotai/kimi") {
  const tool = createTool(schema);
  const tools = provider.normalizeToolSchemas?.({
    provider: "openrouter",
    modelId,
    modelApi: "openai-completions",
    tools: [tool],
  });
  expect(tools).toHaveLength(1);
  const normalizedTool = tools![0]!;
  expect(normalizedTool.execute).toBe(tool.execute);
  return normalizedTool.parameters as Record<string, unknown>;
}

it.each([
  { type: ["string", "null"], anyOf: [{ const: "red" }, { const: null }] },
  { type: "number", minimum: 2, anyOf: [{ type: "integer", maximum: 3 }, { const: 4.5 }] },
])("preserves acceptance for nullable, numeric and object constraints: %j", (value) => {
  const schema = { type: "object", properties: { value }, required: ["value"] };
  const result = normalize(schema);
  expect(result.properties).not.toEqual(schema.properties);
  for (const sample of ["red", "blue", null, 1, 2, 3, 4, 4.5, true, {}]) {
    expect(Check(result, { value: sample }), JSON.stringify(sample)).toBe(
      Check(schema, { value: sample }),
    );
  }
});

it("leaves unevidenced or incompatible unions intact", () => {
  const value = { type: "string", anyOf: [{ oneOf: [{ const: "red" }, { const: "blue" }] }] };
  const schema = { type: "object", properties: { value } };
  expect(normalize(schema)).toEqual(schema);
});

it("walks schema locations without interpreting annotation objects or special property names", () => {
  const union = { type: "string", anyOf: [{ const: "red" }, { const: "blue" }] };
  const typed = { anyOf: ["red", "blue"].map((color) => ({ type: "string", const: color })) };
  const locations = (value: Record<string, unknown>) => ({
    properties: Object.fromEntries([
      ["__proto__", value],
      ["anyOf", { type: "array", items: value }],
    ]),
    $defs: { value },
    dependencies: { dependent: value, list: ["first", "second"] },
  });
  const schema = {
    type: "object",
    ...locations(union),
    default: { value: union },
    examples: [{ value: union }],
  };
  const result = normalize(schema);
  expect(result).toEqual({ ...schema, ...locations(typed) });
  expect(Object.hasOwn(result.properties as object, "__proto__")).toBe(true);
  expect(normalize(result)).toEqual(result);
});

it("preserves existing OpenRouter schemas for DeepSeek", () => {
  const modelId = "openrouter/deepseek-v4-flash";
  const schema = {
    type: "object",
    properties: { value: { anyOf: [{ type: "string" }, { type: "integer" }] } },
    additionalProperties: false,
  };
  expect(normalize(schema, modelId)).toBe(schema);
  expect(
    provider.inspectToolSchemas?.({
      provider: "openrouter",
      modelId,
      tools: [createTool(schema)],
    }),
  ).toEqual([]);
});
