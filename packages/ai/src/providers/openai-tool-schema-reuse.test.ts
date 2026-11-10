import * as normalization from "@openclaw/normalization-core";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { assert, expect, it, vi } from "vitest";
import type { Tool } from "../types.js";
import type { ToolSchemaModelCompat } from "./agent-tools-parameter-schema.js";
import { convertResponsesToolPayload } from "./openai-responses-tools.js";
import { prepareOpenAITools } from "./openai-tool-projection.js";
import { normalizeOpenAIStrictCompatSchema } from "./openai-tool-schema-compat.js";
import { normalizeOpenAIStrictToolParameters as normalize } from "./openai-tool-schema.js";
import {
  getPublishedRuntimeToolInputSchema as publication,
  projectRuntimeToolInputSchema,
  publishRuntimeToolInputSchema,
} from "./tool-schema-json-projection.js";
import { withPreparedToolSchemaNormalization as withPrepared } from "./tool-schema-normalization-cache.js";
import { normalizeToolSchema } from "./tool-schema-normalization.js";

const descriptor = { name: "choose", description: "Choose" };
const choose = (parameters: Tool["parameters"]): Tool => ({ ...descriptor, parameters });
const stripEnumCompat = { unsupportedToolSchemaKeywords: ["enum"] };

function actionSchema() {
  return {
    type: "object",
    properties: { action: { type: "string", enum: ["read"] } },
    required: ["action"],
    additionalProperties: false,
  };
}

function payloadSchema(tools: Tool[], strict = false): Record<string, unknown> {
  return expectDefined(wireTool(tools, strict).parameters, "function schema");
}
function wireTool(tools: Tool[], strict = false) {
  return expectDefined(convertResponsesToolPayload(tools, { strict })[0], "wire tool");
}

function actions(schema: Record<string, unknown>): string[] {
  expect(schema).toMatchObject({ properties: { action: { enum: expect.any(Array) } } });
  return (schema.properties as ReturnType<typeof actionSchema>["properties"]).action.enum;
}

function normalizePrepared(tools: Tool[], modelCompat: ToolSchemaModelCompat) {
  const { projection, schemas } = prepareOpenAITools(tools);
  const parameters = expectDefined(projection.tools[0], "projected tool").parameters;
  return withPrepared(schemas, () => normalize(parameters, true, modelCompat));
}

it("does not traverse admitted request schemas again on normalization cache hits", () => {
  const tools = [choose(actionSchema())];
  payloadSchema(tools);
  const { projection, schemas } = prepareOpenAITools(tools);
  const parameters = expectDefined(projection.tools[0], "projected tool").parameters;
  const entries = vi.spyOn(Object, "entries");
  let traversals: number;
  try {
    withPrepared(schemas, () => normalize(parameters, false));
    traversals = entries.mock.calls.filter(([value]) => value === parameters).length;
  } finally {
    entries.mockRestore();
  }
  expect(traversals).toBe(0);
  // Admission expires with the conversion: direct mutable callers still detect cycles.
  parameters.properties = { self: parameters };
  expect(() => normalize(parameters, false)).toThrow("circular reference");
});

it("prepares published compatibility and union dialects once without sharing their policy", () => {
  const source = {
    type: "object",
    properties: {
      action: { description: null, anyOf: [{ const: "read" }, { const: "write" }] },
    },
  };
  const { schema } = publishRuntimeToolInputSchema(source);
  assert(isRecord(schema));
  const compat = normalizeOpenAIStrictCompatSchema(schema);
  const moonshot = normalizeToolSchema(schema, "moonshot");
  expect(compat).not.toHaveProperty("properties.action.description");
  expect(compat).not.toHaveProperty("properties.action.anyOf.0.type");
  expect(moonshot).toHaveProperty("properties.action.description", null);
  expect(moonshot).toHaveProperty("properties.action.anyOf.0.type", "string");
  expect(normalizeOpenAIStrictCompatSchema(schema)).toBe(compat);
  expect(normalizeToolSchema(schema, "moonshot")).toBe(moonshot);
  expect(publication(compat)).toBeDefined();
  expect(publication(moonshot)).toBeDefined();
  source.properties.action.anyOf[0] = { const: "delete" };
  expect(normalizeOpenAIStrictCompatSchema(source)).toHaveProperty(
    "properties.action.anyOf.0.const",
    "delete",
  );
  const refreshed = publishRuntimeToolInputSchema(source).schema;
  expect(normalizeOpenAIStrictCompatSchema(refreshed)).toHaveProperty(
    "properties.action.anyOf.0.const",
    "delete",
  );
  expect(compat).toHaveProperty("properties.action.anyOf.0.const", "read");
});

it("publishes detached immutable schemas while source edits require a new publication", () => {
  const source = actionSchema();
  const projection = publishRuntimeToolInputSchema(source);
  assert(isRecord(projection.schema));
  const published = expectDefined(publication(projection.schema), "published schema");
  expect(publication(source)).toBeUndefined();
  expect(published.json).toBe(
    '{"type":"object","properties":{"action":{"type":"string","enum":["read"]}},"required":["action"],"additionalProperties":false}',
  );
  source.properties.action.enum.push("write");
  const tool = choose(projection.schema);
  const parameters = payloadSchema([tool]);
  expect(actions(parameters)).toEqual(["read"]);
  expect(() => actions(parameters).push("delete")).toThrow(TypeError);
  expect(() => Object.assign(published, { json: "{}" })).toThrow(TypeError);
  expect(projectRuntimeToolInputSchema(projection.schema)).toBe(projection);
  expect(payloadSchema([tool])).toBe(parameters);
  const refreshed = publishRuntimeToolInputSchema(source);
  assert(isRecord(refreshed.schema));
  expect(publication(refreshed.schema)?.fingerprint).not.toBe(published.fingerprint);
  expect(actions(payloadSchema([choose(refreshed.schema)]))).toEqual(["read", "write"]);
});

it("reuses published provider variants without changing current strict or compatibility options", () => {
  using stringify = vi.spyOn(normalization, "stableStringify");
  const source = actionSchema();
  Reflect.deleteProperty(source, "additionalProperties");
  const projection = publishRuntimeToolInputSchema(source);
  assert(isRecord(projection.schema));
  const tool = choose(projection.schema);
  const tools = [tool];
  const loose = payloadSchema(tools);
  const strict = payloadSchema(tools, true);
  expect(loose).not.toHaveProperty("additionalProperties");
  expect(strict).toHaveProperty("additionalProperties", false);
  expect(strict).not.toBe(loose);
  expect(payloadSchema(tools)).toBe(loose);
  expect(payloadSchema(tools, true)).toBe(strict);
  const stripped = normalizePrepared(tools, stripEnumCompat);
  expect(stripped).not.toHaveProperty("properties.action.enum");
  expect(normalizePrepared(tools, stripEnumCompat)).toBe(stripped);
  expect(payloadSchema(tools, true)).toHaveProperty("properties.action.enum", ["read"]);
  expect(stringify).not.toHaveBeenCalled();
});

it("keeps current provider options isolated", () => {
  const tools = [choose(actionSchema())];
  const modelCompat: ToolSchemaModelCompat = {};
  for (const stripEnum of [false, true, false, true]) {
    modelCompat.unsupportedToolSchemaKeywords = stripEnum ? ["enum"] : [];
    const parameters = normalizePrepared(tools, modelCompat);
    expect(parameters).toHaveProperty("properties.action", {
      type: "string",
      ...(stripEnum ? {} : { enum: ["read"] }),
    });
  }
});

it("rechecks toJSON once per payload through edits, quarantine, and recovery", () => {
  let reads = 0;
  let maximum: number | Error = 1;
  const parameters = {
    toJSON() {
      reads++;
      if (maximum instanceof Error) {
        throw maximum;
      }
      return { type: "object", properties: { amount: { type: "number", maximum } } };
    },
  };
  const tool = { name: "amount", description: "Choose amount", parameters };
  const healthy = { name: "healthy", description: "Healthy sibling", parameters: {} };
  for (const value of [1, 1, 2, Infinity, 3, new Error("unreadable schema"), 3]) {
    maximum = value;
    reads = 0;
    const payload = convertResponsesToolPayload([tool, healthy]);
    expect(reads).toBe(1);
    if (Number.isFinite(value)) {
      expect(payload[0]?.parameters).toMatchObject({
        properties: { amount: { maximum: value } },
      });
    } else {
      expect(payload.map((entry) => entry.name)).toEqual(["healthy"]);
    }
  }
});

it("preserves direct-normalizer identity across prepared cache eviction", () => {
  const parameters = {
    properties: { direct: { type: "string" } },
    toJSON: actionSchema,
  };
  const direct = normalize(parameters, true);
  const tools = [choose(parameters)];
  expect(actions(payloadSchema(tools, true))).toEqual(["read"]);
  for (let index = 0; index < 8; index++) {
    normalizePrepared(tools, {
      unsupportedToolSchemaKeywords: [`synthetic_${index}`],
    });
  }
  expect(normalize(parameters, true)).toBe(direct);
  expect(direct).toHaveProperty("properties.direct");
  expect(direct).not.toHaveProperty("properties.action");
});
