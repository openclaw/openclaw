import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeAll, expect, it } from "vitest";
import plugin from "./index.js";

let provider: Awaited<ReturnType<typeof registerSingleProviderPlugin>>;
beforeAll(async () => {
  provider = await registerSingleProviderPlugin(plugin);
});

function toolSchema(name: string, parameters: unknown) {
  return [{ name, description: "Test tool", parameters }];
}
const object = (properties: Record<string, unknown>) => ({ type: "object", properties });
const emptyObject = object({});
const bareObject = { type: "object" };
const array = (items: unknown) => ({ type: "array", items });
function normalize(tools: unknown[], modelId = "perplexity/sonar-pro") {
  return provider.normalizeToolSchemas?.(schemaContext(modelId, tools));
}
function expectViolations(toolName: string, tools: unknown[], violations: string[]) {
  expect(provider.inspectToolSchemas?.(schemaContext("perplexity/sonar-pro", tools))).toEqual([
    { toolName, toolIndex: 0, violations },
  ]);
}
function schemaContext(modelId: string, tools: unknown[]) {
  return {
    provider: "clawrouter",
    modelId,
    modelApi: "openai-responses",
    model: {
      provider: "clawrouter",
      api: "openai-responses",
      baseUrl: "https://clawrouter.openclaw.ai/v1",
      id: modelId,
    },
    tools,
  } as never;
}

it("normalizes exec-like object maps", () => {
  const tools = toolSchema("exec", {
    ...object({
      env: {
        ...bareObject,
        patternProperties: { "^.*$": bareObject },
        additionalProperties: bareObject,
      },
    }),
    additionalProperties: false,
  });

  expect(normalize(tools)?.[0]?.parameters).toEqual(object({ env: emptyObject }));
  expectViolations("exec", tools, [
    "exec.parameters.properties.env.patternProperties",
    "exec.parameters.properties.env.additionalProperties",
    "exec.parameters.additionalProperties",
    "exec.parameters.properties.env.properties",
  ]);
});

const nestedUnion = (value: unknown) =>
  array(object({ value: { anyOf: [value, { type: "string" }] } }));
it.each([
  [
    "nested unions, arrays, and definitions",
    {
      ...bareObject,
      anyOf: [{ ...bareObject, additionalProperties: true }, nestedUnion(bareObject)],
      $defs: { metadata: { ...bareObject, patternProperties: { ".*": { type: "string" } } } },
    },
    {
      ...emptyObject,
      anyOf: [emptyObject, nestedUnion(emptyObject)],
      $defs: { metadata: emptyObject },
    },
  ],
  [
    "dependentSchemas and unevaluatedProperties containers",
    {
      ...emptyObject,
      dependentSchemas: { x: { ...bareObject, additionalProperties: false } },
      unevaluatedProperties: bareObject,
      additionalItems: { ...bareObject, additionalProperties: false },
    },
    {
      ...emptyObject,
      dependentSchemas: { x: emptyObject },
      unevaluatedProperties: emptyObject,
      additionalItems: emptyObject,
    },
  ],
])("normalizes %s", (_name, input, expected) => {
  expect(normalize(toolSchema("nested", input))?.[0]?.parameters).toEqual(expected);
});

it("treats union types containing object as object schemas", () => {
  const tools = toolSchema(
    "union",
    object({
      payload: { type: ["object", "null"], additionalProperties: { type: "string" } },
    }),
  );

  expect(normalize(tools)?.[0]?.parameters).toEqual(
    object({ payload: { type: ["object", "null"], properties: {} } }),
  );
  expectViolations("union", tools, [
    "union.parameters.properties.payload.additionalProperties",
    "union.parameters.properties.payload.properties",
  ]);
});

it("routes only Perplexity models through the plugin-local normalizer", () => {
  const tools = toolSchema("exec", {
    type: "object",
    patternProperties: { ".*": { type: "string" } },
  });

  expect(normalize(tools, "PeRpLeXiTy/sonar-pro")?.[0]?.parameters).toEqual(emptyObject);
  expect(normalize(tools, "openai/gpt-5.5")).toBe(tools);
});
