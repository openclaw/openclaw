import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, assert, expect, it, vi } from "vitest";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../../../src/infra/runtime-worker-url.js";
import { configureAiTransportHost } from "../host.js";
import type { Tool } from "../types.js";
import { normalizeToolParameterSchema } from "./agent-tools-parameter-schema.js";
import { cleanSchemaForGemini } from "./clean-for-gemini.js";
import {
  cleanSchemaForLlamacppGbnf,
  findLlamacppGbnfSchemaViolations,
} from "./clean-for-llamacpp-gbnf.js";
import { convertResponsesToolPayload as convertTools } from "./openai-responses-tools.js";
import {
  normalizeOpenAIStrictCompatSchema,
  findOpenAIStrictSchemaViolations,
} from "./openai-tool-schema-compat.js";
import { stripUnsupportedSchemaKeywords } from "./schema-keyword-strip.js";
import { toolSchemaDepthEntrypoint } from "./tool-schema-depth-runtime.test-support.js";
import { MAX_TOOL_SCHEMA_DEPTH, truncateToolSchemaDepth } from "./tool-schema-depth.js";
import { publishRuntimeToolInputSchema } from "./tool-schema-json-projection.js";

type Schema = Record<string, unknown>;
const execFileAsync = promisify(execFile);
function tool(name: string, parameters: Tool["parameters"]): Tool {
  return { name, description: name, parameters };
}
const strictPayload = (parameters: Tool["parameters"], name = "reference_tool") =>
  convertTools([tool(name, parameters)], { strict: true })[0];
const logWarn = vi.fn();
beforeEach(() => configureAiTransportHost({ logWarn: logWarn.mockClear() }));
function expectLeaf(input: unknown, depth: number, leaf: unknown = {}, composition = false) {
  let count = 0;
  let schema = input;
  while (isRecord(schema)) {
    const children = composition ? schema.allOf : schema.properties;
    if (!Array.isArray(children) && !isRecord(children)) {
      break;
    }
    schema = Array.isArray(children) ? children[0] : children.next;
    count++;
  }
  expect({ depth: count, leaf: schema }).toEqual({ depth, leaf });
}

function objectSchema(properties: Schema, strict = false) {
  return {
    type: "object",
    properties,
    ...(strict ? { required: Object.keys(properties), additionalProperties: false } : {}),
  };
}
function nestedSchema(depth: number, strict = false, leaf: Schema = { type: "string" }): Schema {
  let schema = leaf;
  for (let index = 0; index < depth; index++) {
    schema = objectSchema({ next: schema }, strict);
  }
  return schema;
}

afterEach(() => configureAiTransportHost({}));

// Vitest's worker stack can accept validators that overflow a cold CLI main thread.
it("compiles model-emitted arguments on a cold main-thread stack", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    [...resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(toolSchemaDepthEntrypoint))],
    { cwd: process.cwd(), encoding: "utf8", timeout: 20_000 },
  );
  expect(stdout).toBe("ok");
}, 30_000);
it("Gemini keeps a deep tool schema usable", () => {
  const original = nestedSchema(5000);
  const normalized = cleanSchemaForGemini(original);
  expectLeaf(normalized, MAX_TOOL_SCHEMA_DEPTH + 1);
  expectLeaf(original, 5000, { type: "string" });
  expect(() => JSON.stringify(normalized)).not.toThrow();
});

it.each([
  ["published", (schema: unknown) => publishRuntimeToolInputSchema(schema).schema],
  ["compat normalized", normalizeOpenAIStrictCompatSchema],
  ["llama.cpp cleaned", cleanSchemaForLlamacppGbnf],
  ["keyword stripped", (schema: unknown) => stripUnsupportedSchemaKeywords(schema, new Set())],
] as const)(
  "downgrades truncated %s schemas across projection and cache reuse",
  (_name, prepare) => {
    const parameters = prepare(nestedSchema(5000, true));
    assert(isRecord(parameters));
    const tools = [tool("deep_strict", parameters)];
    for (let index = 0; index < 2; index++) {
      const payload = convertTools(tools, { strict: true });
      expect(payload).toHaveLength(1);
      expect(payload[0]).toMatchObject({ name: "deep_strict", strict: false });
      expect(findOpenAIStrictSchemaViolations(payload[0]?.parameters, "parameters")).toEqual([
        "parameters.depth",
      ]);
    }
  },
);

it("counts map and composition containers once while preserving literal data and shallow aliases", () => {
  const shared = nestedSchema(3);
  let nested: unknown = shared;
  for (let index = 0; index < 5000; index++) {
    nested = { allOf: [nested] };
  }
  const schema = {
    type: "object",
    properties: { short: shared, long: nested },
    default: { properties: nested },
    enum: [{ items: nested }],
  };
  const normalized = truncateToolSchemaDepth(schema);
  assert(isRecord(normalized) && isRecord(normalized.properties));
  expect(normalized.default).toBe(schema.default);
  expect(normalized.enum).toBe(schema.enum);
  expect(normalized.properties.short).toBe(shared);
  expectLeaf(normalized.properties.long, MAX_TOOL_SCHEMA_DEPTH, {}, true);
});

it("bounds flat reference expansion and reports the named tool once", () => {
  const definitions: Schema = { 0: { type: "string" } };
  for (let depth = 1; depth <= 5000; depth++) {
    definitions[depth] = { $ref: `#/$defs/${depth - 1}` };
  }
  const schema = { ...objectSchema({ value: { $ref: "#/$defs/5000" } }, true), $defs: definitions };
  const options = { toolName: "reference_tool" };
  const parameters = normalizeToolParameterSchema(schema);
  const truncated = { properties: { value: {} } };
  expect(normalizeToolParameterSchema(schema, options)).toMatchObject(truncated);
  normalizeToolParameterSchema(schema, options);
  expect(logWarn).toHaveBeenCalledTimes(1);
  expect(logWarn.mock.calls[0]?.[1]).toContain('Tool "reference_tool"');
  for (const source of [parameters, { toJSON: () => parameters }]) {
    const tools = [tool("reference_tool", source)];
    for (let index = 0; index < 2; index++) {
      expect(convertTools(tools, { strict: true })).toMatchObject([
        { name: "reference_tool", parameters: truncated, strict: false },
      ]);
    }
  }
  let materialized: unknown = parameters;
  const tools = [tool("mutable_reference_tool", { toJSON: () => materialized })];
  const freshSchema: unknown = structuredClone(parameters);
  for (const next of [parameters, freshSchema, parameters, freshSchema]) {
    materialized = next;
    expect(convertTools(tools, { strict: true })[0]?.strict).toBe(next === freshSchema);
  }
  expect(
    strictPayload(normalizeToolParameterSchema(objectSchema({ nested: parameters }, true)))?.strict,
  ).toBe(false);

  const markedWithToJSON = normalizeToolParameterSchema({ ...schema });
  Object.defineProperty(markedWithToJSON, "toJSON", { value: () => freshSchema });
  expect(strictPayload(markedWithToJSON, "recovered")?.strict).toBe(true);
});

it("keeps deep provider tools and observes source edits and toJSON once per payload", () => {
  let schema = nestedSchema(5000, true);
  const toJSON = vi.fn(() => schema);
  const tools = [tool("deep_tool", { toJSON }), tool("healthy", objectSchema({}))];
  for (let index = 0; index < 2; index++) {
    const payload = convertTools(tools, { strict: true });
    expect(payload.map((entry) => entry.name)).toEqual(["deep_tool", "healthy"]);
    expect(payload[0]?.strict).toBe(false);
    expectLeaf(payload[0]?.parameters, MAX_TOOL_SCHEMA_DEPTH + 1);
  }
  expect(logWarn).toHaveBeenCalledTimes(1);
  expect(toJSON).toHaveBeenCalledTimes(2);
  schema = nestedSchema(2, true);
  const recovered = convertTools(tools, { strict: true });
  expect(recovered[0]?.strict).toBe(true);
  expectLeaf(recovered[0]?.parameters, 2, { type: "string" });
  expect(toJSON).toHaveBeenCalledTimes(3);
});

it("bounds nested toJSON schemas without evaluating getters more than once", () => {
  const schema = nestedSchema(5000);
  const toJSON = vi.fn(() => schema);
  const getProperties = vi.fn(() => ({ payload: { toJSON } }));
  const parameters = { type: "object" };
  Object.defineProperty(parameters, "properties", { enumerable: true, get: getProperties });
  for (let index = 0; index < 2; index++) {
    const payload = convertTools([tool("dynamic", parameters)]);
    expect(payload).toHaveLength(1);
    const result = payload[0]?.parameters;
    expectLeaf(
      isRecord(result) && isRecord(result.properties) ? result.properties.payload : undefined,
      MAX_TOOL_SCHEMA_DEPTH,
    );
  }
  expect(toJSON).toHaveBeenCalledTimes(2);
  expect(getProperties).toHaveBeenCalledTimes(2);
  expect(logWarn).toHaveBeenCalledTimes(1);
});

it("bounds diagnostic walkers and still rejects raw cycles", () => {
  expect(findLlamacppGbnfSchemaViolations(nestedSchema(5000), "tool")).toEqual([]);
  expect(findOpenAIStrictSchemaViolations(nestedSchema(5000), "tool").length).toBeGreaterThan(0);
  const schema = { type: "object", properties: {} as Schema };
  schema.properties.self = schema;
  expect(() => cleanSchemaForGemini(schema)).toThrow(TypeError);
  expect(() => stripUnsupportedSchemaKeywords(schema, new Set())).toThrow(TypeError);
});

it("preserves property dependency names at the schema depth cutoff", () => {
  const leaf = { type: "object", dependencies: { billing: ["creditCard"] } };
  const bounded = normalizeToolParameterSchema(nestedSchema(MAX_TOOL_SCHEMA_DEPTH, false, leaf));
  expectLeaf(bounded, MAX_TOOL_SCHEMA_DEPTH, leaf);
});
