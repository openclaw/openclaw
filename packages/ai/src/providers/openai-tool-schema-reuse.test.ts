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
  if (!tool?.parameters) {
    throw new Error("Expected a function schema");
  }
  return tool.parameters;
}

function actions(schema: Record<string, unknown>): string[] {
  expect(schema).toMatchObject({ properties: { action: { enum: expect.any(Array) } } });
  return (schema.properties as ReturnType<typeof actionSchema>["properties"]).action.enum;
}

function normalizePreparedSchema(
  tools: Tool[],
  strict: boolean,
  modelCompat: ToolSchemaModelCompat,
) {
  const { projection, schemas } = prepareOpenAITools(tools);
  return withPreparedToolSchemaNormalization(schemas, () =>
    normalizeOpenAIStrictToolParameters(
      expectDefined(projection.tools[0], "projected tool").parameters,
      strict,
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

  it.each([false, true])("keeps current provider options isolated with strict=%s", (strict) => {
    const tools = [{ name: "choose", description: "Choose", parameters: actionSchema() }];
    const modelCompat: ToolSchemaModelCompat = {};
    for (const stripEnum of [false, true, false, true]) {
      modelCompat.unsupportedToolSchemaKeywords = stripEnum ? ["enum"] : [];
      const parameters = normalizePreparedSchema(tools, strict, modelCompat);
      if (stripEnum) {
        expect(parameters).not.toHaveProperty("properties.action.enum");
      } else {
        expect(parameters).toHaveProperty("properties.action.enum", ["read"]);
      }
    }
  });

  it("rechecks toJSON, quarantine, and recovery while reading each descriptor once", () => {
    const reads: string[] = [];
    let maximum = 1;
    let unreadable = false;
    const parameters = {
      toJSON() {
        reads.push("json");
        if (unreadable) {
          throw new Error("unreadable schema");
        }
        return { type: "object", properties: { amount: { type: "number", maximum } } };
      },
    };
    const tool = new Proxy(
      { name: "amount", description: "Choose amount", parameters },
      {
        get(target, property, receiver) {
          if (property === "name" || property === "parameters" || property === "description") {
            reads.push(property);
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const healthy = { name: "healthy", description: "Healthy sibling", parameters: {} };
    for (const value of [1, 1, 2, Number.POSITIVE_INFINITY, 3]) {
      maximum = value;
      reads.length = 0;
      const payload = convertResponsesToolPayload([tool, healthy]);
      expect(reads).toEqual([
        "name",
        "parameters",
        "json",
        ...(Number.isFinite(value) ? ["description"] : []),
      ]);
      if (Number.isFinite(value)) {
        expect(payload[0]?.parameters).toMatchObject({
          properties: { amount: { maximum: value } },
        });
      } else {
        expect(payload.map((entry) => entry.name)).toEqual(["healthy"]);
      }
    }
    unreadable = true;
    expect(convertResponsesToolPayload([tool, healthy]).map((entry) => entry.name)).toEqual([
      "healthy",
    ]);
    unreadable = false;
    expect(payloadSchema([tool])).toMatchObject({ properties: { amount: { maximum: 3 } } });
  });

  it.each([false, true])(
    "preserves the direct-normalizer identity contract alongside projected strict=%s",
    (strict) => {
      const wire = actionSchema();
      const parameters = {
        properties: { direct: { type: "string" } },
        required: ["direct"],
        additionalProperties: false,
        toJSON: () => wire,
      };
      const direct = normalizeOpenAIStrictToolParameters(parameters, strict);
      const tools = [{ name: "choose", description: "Choose", parameters }];
      expect(actions(payloadSchema(tools, strict))).toEqual(["read"]);
      wire.properties.action.enum.push("write");
      expect(actions(payloadSchema(tools, strict))).toEqual(["read", "write"]);
      for (let index = 0; index < 8; index++) {
        normalizePreparedSchema(tools, strict, {
          unsupportedToolSchemaKeywords: [`synthetic_${index}`],
        });
      }
      expect(normalizeOpenAIStrictToolParameters(parameters, strict)).toBe(direct);
      expect(direct).toHaveProperty("properties.direct");
      expect(direct).not.toHaveProperty("properties.action");
    },
  );

  it("keeps hostile public projections outside source-cache provenance", () => {
    const parameters = actionSchema();
    const tools = [{ name: "choose", description: "Choose", parameters }];
    expect(actions(payloadSchema(tools))).toEqual(["read"]);
    const projection = projectOpenAITools(tools);
    expect(Object.keys(projection)).toEqual(["inputToolCount", "tools", "diagnostics"]);
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

    const another = expectDefined(projectOpenAITools(tools).tools[0], "projected tool").parameters;
    Object.defineProperty(another, "properties", {
      get: () => {
        throw new Error("public projection changed");
      },
    });
    expect(() => normalizeToolParameterSchema(another)).toThrow("public projection changed");
    expect(actions(payloadSchema(tools))).toEqual(["read"]);
  });

  it.each([false, true])(
    "retires private facts after return or throw=%s and reentry",
    (throwing) => {
      const outer = prepareOpenAITools([
        { name: "outer", description: "Outer", parameters: actionSchema() },
      ]);
      const inner = prepareOpenAITools([
        { name: "inner", description: "Inner", parameters: actionSchema() },
      ]);
      const schema = expectDefined(outer.projection.tools[0], "outer tool").parameters;
      const convert = () =>
        withPreparedToolSchemaNormalization(outer.schemas, () => {
          const first = normalizeToolParameterSchema(schema);
          expect(() =>
            withPreparedToolSchemaNormalization(inner.schemas, () => {
              normalizeToolParameterSchema(
                expectDefined(inner.projection.tools[0], "inner tool").parameters,
              );
              throw new Error("inner");
            }),
          ).toThrow("inner");
          const second = normalizeToolParameterSchema(schema);
          const third = normalizeToolParameterSchema(schema);
          expect(second).toEqual(first);
          expect(second).not.toBe(first);
          expect(third).toEqual(second);
          expect(third).not.toBe(second);
          if (throwing) {
            throw new Error("outer");
          }
        });
      if (throwing) {
        expect(convert).toThrow("outer");
      } else {
        convert();
      }
      const direct = normalizeToolParameterSchema(schema);
      expect(normalizeToolParameterSchema(schema)).toBe(direct);
    },
  );
});
