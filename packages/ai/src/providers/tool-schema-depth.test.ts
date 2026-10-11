import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../../../src/infra/runtime-worker-url.js";
import { configureAiTransportHost } from "../host.js";
import { normalizeToolParameterSchema } from "./agent-tools-parameter-schema.js";
import { cleanSchemaForGemini } from "./clean-for-gemini.js";
import {
  cleanSchemaForLlamacppGbnf,
  findLlamacppGbnfSchemaViolations,
} from "./clean-for-llamacpp-gbnf.js";
import { convertResponsesToolPayload } from "./openai-responses-tools.js";
import {
  normalizeOpenAIStrictCompatSchema,
  findOpenAIStrictSchemaViolations,
} from "./openai-tool-schema-compat.js";
import { normalizeStrictOpenAIJsonSchema } from "./openai-tool-schema.js";
import { stripUnsupportedSchemaKeywords } from "./schema-keyword-strip.js";
import { toolSchemaDepthEntrypoint } from "./tool-schema-depth-runtime.test-support.js";
import { MAX_TOOL_SCHEMA_DEPTH, truncateToolSchemaDepth } from "./tool-schema-depth.js";

const execFileAsync = promisify(execFile);

function nestedSchema(depth: number, strict = false): Record<string, unknown> {
  let schema: Record<string, unknown> = { type: "string" };
  for (let index = 0; index < depth; index++) {
    schema = {
      type: "object",
      properties: { next: schema },
      ...(strict ? { required: ["next"], additionalProperties: false } : {}),
    };
  }
  return schema;
}

function nestedLeaf(schema: unknown): { depth: number; leaf: unknown } {
  let depth = 0;
  let leaf = schema;
  while (isRecord(leaf) && isRecord(leaf.properties) && "next" in leaf.properties) {
    depth++;
    leaf = leaf.properties.next;
  }
  return { depth, leaf };
}

afterEach(() => configureAiTransportHost({}));

describe("shared tool schema depth budget", () => {
  // Vitest's worker stack can accept validators that overflow a cold CLI main thread.
  it("compiles model-emitted arguments on a cold main-thread stack", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [...resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(toolSchemaDepthEntrypoint))],
      { cwd: process.cwd(), encoding: "utf8", timeout: 20_000 },
    );
    expect(stdout).toBe("ok");
  }, 30_000);
  it.each([
    ["parameters", normalizeToolParameterSchema],
    ["strict", normalizeStrictOpenAIJsonSchema],
    ["compat", normalizeOpenAIStrictCompatSchema],
    ["llama.cpp", cleanSchemaForLlamacppGbnf],
    ["Gemini", cleanSchemaForGemini],
    [
      "keyword stripping",
      (schema: unknown) => stripUnsupportedSchemaKeywords(schema, new Set(["format"])),
    ],
  ] as const)("%s keeps a deep tool schema usable", (_name, normalize) => {
    const original = nestedSchema(5000);
    const normalized = normalize(original);
    expect(nestedLeaf(normalized)).toEqual({ depth: MAX_TOOL_SCHEMA_DEPTH + 1, leaf: {} });
    expect(nestedLeaf(original)).toEqual({ depth: 5000, leaf: { type: "string" } });
    expect(() => JSON.stringify(normalized)).not.toThrow();
  });

  it.each([
    ["raw", (schema: unknown) => schema],
    ["host normalized", normalizeToolParameterSchema],
    ["strict normalized", normalizeStrictOpenAIJsonSchema],
    ["compat normalized", normalizeOpenAIStrictCompatSchema],
    ["llama.cpp cleaned", cleanSchemaForLlamacppGbnf],
    ["keyword stripped", (schema: unknown) => stripUnsupportedSchemaKeywords(schema, new Set())],
  ] as const)(
    "downgrades truncated %s schemas across projection and cache reuse",
    (_name, prepare) => {
      const parameters = prepare(nestedSchema(5000, true));
      assert(isRecord(parameters));
      const tools = [{ name: "deep_strict", description: "Deep strict tool", parameters }];
      for (let index = 0; index < 2; index++) {
        const payload = convertResponsesToolPayload(tools, { strict: true });
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
    expect(normalized).toMatchObject({ properties: { short: shared } });
    expect(isRecord(normalized) && normalized.default).toBe(schema.default);
    expect(isRecord(normalized) && normalized.enum).toBe(schema.enum);
    expect(
      isRecord(normalized) && isRecord(normalized.properties) && normalized.properties.short,
    ).toBe(shared);
    let node =
      isRecord(normalized) && isRecord(normalized.properties)
        ? normalized.properties.long
        : undefined;
    for (let index = 0; index < MAX_TOOL_SCHEMA_DEPTH; index++) {
      expect(isRecord(node) && Array.isArray(node.allOf)).toBe(true);
      node = isRecord(node) && Array.isArray(node.allOf) ? node.allOf[0] : undefined;
    }
    expect(node).toEqual({});
  });

  it("bounds flat reference expansion and reports the named tool once", () => {
    const definitions: Record<string, unknown> = { leaf: { type: "string" } };
    let target = "leaf";
    for (let index = 0; index < 5000; index++) {
      const name = `node${index}`;
      definitions[name] = { $ref: `#/$defs/${target}` };
      target = name;
    }
    const schema = {
      type: "object",
      properties: { value: { $ref: `#/$defs/${target}` } },
      required: ["value"],
      additionalProperties: false,
      $defs: definitions,
    };
    const logWarn = vi.fn();
    configureAiTransportHost({ logWarn });
    const options = { toolName: "reference_tool" };
    normalizeToolParameterSchema(schema);
    expect(normalizeToolParameterSchema(schema, options)).toMatchObject({
      properties: { value: {} },
    });
    normalizeToolParameterSchema(schema, options);
    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logWarn.mock.calls[0]?.[1]).toContain('Tool "reference_tool"');
    const parameters = normalizeToolParameterSchema(schema);
    for (const source of [parameters, { toJSON: () => parameters }]) {
      const tools = [{ name: "reference_tool", description: "Reference tool", parameters: source }];
      for (let index = 0; index < 2; index++) {
        expect(convertResponsesToolPayload(tools, { strict: true })[0]).toMatchObject({
          name: "reference_tool",
          parameters: { properties: { value: {} } },
          strict: false,
        });
      }
    }
    let materialized: unknown = parameters;
    const tools = [
      {
        name: "mutable_reference_tool",
        description: "Mutable reference tool",
        parameters: { toJSON: () => materialized },
      },
    ];
    const freshSchema: unknown = structuredClone(parameters);
    for (const [next, strict] of [
      [parameters, false],
      [freshSchema, true],
      [parameters, false],
      [freshSchema, true],
    ] as const) {
      materialized = next;
      expect(convertResponsesToolPayload(tools, { strict: true })[0]?.strict).toBe(strict);
    }
    const nested = normalizeToolParameterSchema({
      type: "object",
      properties: { nested: parameters },
      required: ["nested"],
      additionalProperties: false,
    });
    expect(
      convertResponsesToolPayload([{ name: "nested", description: "Nested", parameters: nested }], {
        strict: true,
      })[0]?.strict,
    ).toBe(false);

    const markedWithToJSON = normalizeToolParameterSchema({ ...schema });
    Object.defineProperty(markedWithToJSON, "toJSON", { value: () => freshSchema });
    expect(
      convertResponsesToolPayload(
        [{ name: "recovered", description: "Recovered", parameters: markedWithToJSON }],
        { strict: true },
      )[0]?.strict,
    ).toBe(true);
  });

  it("keeps deep provider tools and observes source edits and toJSON once per payload", () => {
    const logWarn = vi.fn();
    configureAiTransportHost({ logWarn });
    let schema = nestedSchema(5000, true);
    const toJSON = vi.fn(() => schema);
    const parameters = { toJSON };
    const tools = [
      { name: "deep_tool", description: "Deep tool", parameters },
      {
        name: "healthy",
        description: "Healthy tool",
        parameters: { type: "object", properties: {} },
      },
    ];
    for (let index = 0; index < 2; index++) {
      const payload = convertResponsesToolPayload(tools, { strict: true });
      expect(payload.map((tool) => tool.name)).toEqual(["deep_tool", "healthy"]);
      expect(payload[0]?.strict).toBe(false);
      expect(nestedLeaf(payload[0]?.parameters)).toEqual({
        depth: MAX_TOOL_SCHEMA_DEPTH + 1,
        leaf: {},
      });
    }
    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(toJSON).toHaveBeenCalledTimes(2);
    schema = nestedSchema(2, true);
    const recovered = convertResponsesToolPayload(tools, { strict: true });
    expect(recovered[0]?.strict).toBe(true);
    expect(nestedLeaf(recovered[0]?.parameters)).toEqual({
      depth: 2,
      leaf: { type: "string" },
    });
    expect(toJSON).toHaveBeenCalledTimes(3);
  });

  it("reports truncation after an unnamed normalization cache hit", () => {
    const schema = nestedSchema(5000);
    normalizeToolParameterSchema(schema);
    const logWarn = vi.fn();
    configureAiTransportHost({ logWarn });
    normalizeToolParameterSchema(schema, { toolName: "cached_tool" });
    normalizeToolParameterSchema(schema, { toolName: "cached_tool" });
    expect(logWarn).toHaveBeenCalledTimes(1);
  });

  it("bounds nested toJSON schemas without evaluating getters more than once", () => {
    const schema = nestedSchema(5000);
    const toJSON = vi.fn(() => schema);
    const getProperties = vi.fn(() => ({ payload: { toJSON } }));
    const parameters = {
      type: "object",
      get properties() {
        return getProperties();
      },
    };
    const logWarn = vi.fn();
    configureAiTransportHost({ logWarn });
    for (let index = 0; index < 2; index++) {
      const payload = convertResponsesToolPayload([
        { name: "dynamic", description: "Dynamic tool", parameters },
      ]);
      expect(payload).toHaveLength(1);
      const result = payload[0]?.parameters;
      expect(
        nestedLeaf(
          isRecord(result) && isRecord(result.properties) ? result.properties.payload : undefined,
        ),
      ).toEqual({ depth: MAX_TOOL_SCHEMA_DEPTH, leaf: {} });
    }
    expect(toJSON).toHaveBeenCalledTimes(2);
    expect(getProperties).toHaveBeenCalledTimes(2);
    expect(logWarn).toHaveBeenCalledTimes(1);
  });

  it("bounds diagnostic walkers and still rejects raw cycles", () => {
    expect(findLlamacppGbnfSchemaViolations(nestedSchema(5000), "tool")).toEqual([]);
    expect(findOpenAIStrictSchemaViolations(nestedSchema(5000), "tool").length).toBeGreaterThan(0);
    const schema = { type: "object", properties: {} as Record<string, unknown> };
    schema.properties.self = schema;
    expect(() => cleanSchemaForGemini(schema)).toThrow(TypeError);
    expect(() => stripUnsupportedSchemaKeywords(schema, new Set())).toThrow(TypeError);
  });

  it("preserves property dependency names at the schema depth cutoff", () => {
    let schema: Record<string, unknown> = {
      type: "object",
      dependencies: { billing: ["creditCard"] },
    };
    for (let depth = 0; depth < MAX_TOOL_SCHEMA_DEPTH; depth++) {
      schema = { type: "object", properties: { next: schema } };
    }
    expect(nestedLeaf(normalizeToolParameterSchema(schema))).toEqual({
      depth: MAX_TOOL_SCHEMA_DEPTH,
      leaf: { type: "object", dependencies: { billing: ["creditCard"] } },
    });
  });
});
