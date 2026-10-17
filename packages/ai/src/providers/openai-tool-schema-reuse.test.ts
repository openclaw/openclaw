import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { assert, describe, expect, it } from "vitest";
import type { Tool } from "../types.js";
import type { ToolSchemaModelCompat } from "./agent-tools-parameter-schema.js";
import { convertResponsesToolPayload } from "./openai-responses-tools.js";
import { prepareOpenAITools } from "./openai-tool-projection.js";
import { normalizeOpenAIStrictToolParameters } from "./openai-tool-schema.js";
import {
  getPublishedRuntimeToolInputSchema,
  projectRuntimeToolInputSchema,
  publishRuntimeToolInputSchema,
} from "./tool-schema-json-projection.js";
import { withPreparedToolSchemaNormalization } from "./tool-schema-normalization-cache.js";

function actionSchema() {
  return {
    type: "object",
    properties: { action: { type: "string", enum: ["read"] } },
    required: ["action"],
    additionalProperties: false,
  };
}

function payloadSchema(tools: Tool[], strict = false): Record<string, unknown> {
  const [tool] = convertResponsesToolPayload(tools, { strict });
  return expectDefined(tool?.parameters, "function schema");
}

function actions(schema: Record<string, unknown>): string[] {
  expect(schema).toMatchObject({ properties: { action: { enum: expect.any(Array) } } });
  return (schema.properties as ReturnType<typeof actionSchema>["properties"]).action.enum;
}

function normalizePreparedSchema(tools: Tool[], modelCompat: ToolSchemaModelCompat) {
  const { projection, schemas } = prepareOpenAITools(tools);
  return withPreparedToolSchemaNormalization(schemas, () =>
    normalizeOpenAIStrictToolParameters(
      expectDefined(projection.tools[0], "projected tool").parameters,
      true,
      modelCompat,
    ),
  );
}

describe("OpenAI tool schema reuse", () => {
  it("publishes detached immutable schemas while source edits require a new publication", () => {
    const source = actionSchema();
    const projection = publishRuntimeToolInputSchema(source);
    assert(isRecord(projection.schema));
    const published = getPublishedRuntimeToolInputSchema(projection.schema);
    assert(published);
    expect(getPublishedRuntimeToolInputSchema(source)).toBeUndefined();
    expect(published.json).toBe(
      '{"type":"object","properties":{"action":{"type":"string","enum":["read"]}},"required":["action"],"additionalProperties":false}',
    );
    source.properties.action.enum.push("write");
    const tool = { name: "choose", description: "Choose", parameters: projection.schema };
    const parameters = payloadSchema([tool]);
    expect(actions(parameters)).toEqual(["read"]);
    expect(() => actions(parameters).push("delete")).toThrow(TypeError);
    expect(() => Object.assign(published, { json: "{}" })).toThrow(TypeError);
    expect(projectRuntimeToolInputSchema(projection.schema)).toBe(projection);
    expect(payloadSchema([tool])).toBe(parameters);
    const refreshed = publishRuntimeToolInputSchema(source);
    assert(isRecord(refreshed.schema));
    expect(getPublishedRuntimeToolInputSchema(refreshed.schema)?.fingerprint).not.toBe(
      published.fingerprint,
    );
    expect(payloadSchema([{ ...tool, parameters: refreshed.schema }])).toHaveProperty(
      "properties.action.enum",
      ["read", "write"],
    );
  });

  it("reuses published provider variants without changing current strict or compatibility options", () => {
    const source = actionSchema();
    Reflect.deleteProperty(source, "additionalProperties");
    const projection = publishRuntimeToolInputSchema(source);
    assert(isRecord(projection.schema));
    const tools = [{ name: "choose", description: "Choose", parameters: projection.schema }];
    const loose = payloadSchema(tools);
    const strict = payloadSchema(tools, true);
    expect(loose).not.toHaveProperty("additionalProperties");
    expect(strict).toHaveProperty("additionalProperties", false);
    expect(strict).not.toBe(loose);
    expect(payloadSchema(tools)).toBe(loose);
    expect(payloadSchema(tools, true)).toBe(strict);
    const wire = expectDefined(
      convertResponsesToolPayload(tools, { strict: true })[0],
      "wire tool",
    );
    expect(convertResponsesToolPayload(tools, { strict: true })[0]).toBe(wire);
    expect(() => Object.assign(wire, { name: "other" })).toThrow(TypeError);
    const renamed = convertResponsesToolPayload(
      [
        {
          ...expectDefined(tools[0], "source tool"),
          name: "renamed",
          description: "New description",
        },
      ],
      { strict: true },
    )[0];
    expect(renamed).toMatchObject({ name: "renamed", description: "New description" });
    expect(renamed).not.toBe(wire);
    const stripped = normalizePreparedSchema(tools, { unsupportedToolSchemaKeywords: ["enum"] });
    expect(stripped).not.toHaveProperty("properties.action.enum");
    expect(normalizePreparedSchema(tools, { unsupportedToolSchemaKeywords: ["enum"] })).toBe(
      stripped,
    );
    expect(payloadSchema(tools, true)).toHaveProperty("properties.action.enum", ["read"]);
  });

  it("keeps current provider options isolated", () => {
    const tools = [{ name: "choose", description: "Choose", parameters: actionSchema() }];
    const modelCompat: ToolSchemaModelCompat = {};
    for (const stripEnum of [false, true, false, true]) {
      modelCompat.unsupportedToolSchemaKeywords = stripEnum ? ["enum"] : [];
      const parameters = normalizePreparedSchema(tools, modelCompat);
      if (stripEnum) {
        expect(parameters).not.toHaveProperty("properties.action.enum");
      } else {
        expect(parameters).toHaveProperty("properties.action.enum", ["read"]);
      }
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
    const direct = normalizeOpenAIStrictToolParameters(parameters, true);
    const tools = [{ name: "choose", description: "Choose", parameters }];
    expect(actions(payloadSchema(tools, true))).toEqual(["read"]);
    for (let index = 0; index < 8; index++) {
      normalizePreparedSchema(tools, {
        unsupportedToolSchemaKeywords: [`synthetic_${index}`],
      });
    }
    expect(normalizeOpenAIStrictToolParameters(parameters, true)).toBe(direct);
    expect(direct).toHaveProperty("properties.direct");
    expect(direct).not.toHaveProperty("properties.action");
  });
});
