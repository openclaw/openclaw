import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it } from "vitest";
import type { Tool } from "../types.js";
import {
  normalizeToolParameterSchema,
  type ToolSchemaModelCompat,
} from "./agent-tools-parameter-schema.js";
import { convertResponsesToolPayload } from "./openai-responses-tools.js";
import { prepareOpenAITools, projectOpenAITools } from "./openai-tool-projection.js";
import { normalizeOpenAIStrictToolParameters } from "./openai-tool-schema.js";
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
  it.each([false, true])(
    "keeps payloads independent and sees in-place source edits with strict=%s",
    (strict) => {
      const parameters = actionSchema();
      const tools = [{ name: "choose", description: "Choose an action", parameters }];
      const first = payloadSchema(tools, strict);
      actions(first).push("output-only");

      const second = payloadSchema(tools, strict);
      expect(actions(second)).toEqual(["read"]);
      expect(second).not.toBe(first);
      parameters.properties.action.enum.push("write");
      expect(actions(payloadSchema(tools, strict))).toEqual(["read", "write"]);
      Object.assign(parameters, actionSchema());
      expect(actions(payloadSchema(tools, strict))).toEqual(["read"]);
      expect(actions(second)).toEqual(["read"]);
    },
  );

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

  it("keeps hostile public projections outside source-cache provenance", () => {
    const parameters = actionSchema();
    const tools = [{ name: "choose", description: "Choose", parameters }];
    expect(actions(payloadSchema(tools))).toEqual(["read"]);
    const projection = projectOpenAITools(tools);
    const projected = expectDefined(projection.tools[0], "projected tool").parameters;
    actions(projected).push("public-edit");
    Object.defineProperty(projected, "toJSON", {
      value: () => parameters,
      enumerable: false,
    });
    expect(normalizeToolParameterSchema(projected)).toHaveProperty("properties.action.enum", [
      "read",
      "public-edit",
    ]);
    expect(actions(payloadSchema(tools))).toEqual(["read"]);
  });

  it("restores outer facts after an inner throw and retires them on return", () => {
    const outer = prepareOpenAITools([{ name: "outer", parameters: actionSchema() }]);
    const schema = expectDefined(outer.projection.tools[0], "outer tool").parameters;
    withPreparedToolSchemaNormalization(outer.schemas, () => {
      const first = normalizeToolParameterSchema(schema);
      expect(() =>
        withPreparedToolSchemaNormalization(new Map(), () => {
          throw new Error("inner");
        }),
      ).toThrow("inner");
      const second = normalizeToolParameterSchema(schema);
      const third = normalizeToolParameterSchema(schema);
      expect(second).toEqual(first);
      expect(second).not.toBe(first);
      expect(third).toEqual(second);
      expect(third).not.toBe(second);
    });
    const direct = normalizeToolParameterSchema(schema);
    expect(normalizeToolParameterSchema(schema)).toBe(direct);
  });
});
