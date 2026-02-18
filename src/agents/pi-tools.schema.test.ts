import { describe, expect, it } from "vitest";
import { normalizeToolParameters } from "./pi-tools.schema.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

function makeTool(parameters: unknown): AnyAgentTool {
  return { name: "test_tool", description: "test", parameters } as AnyAgentTool;
}

describe("normalizeToolParameters", () => {
  describe("type:object schema without properties — OpenAI-compatible provider fix (#20224)", () => {
    it("injects empty properties when schema has type:object but no properties field", () => {
      const tool = makeTool({ type: "object" });
      const result = normalizeToolParameters(tool);
      expect((result.parameters as Record<string, unknown>).properties).toEqual({});
    });

    it("injects empty properties when schema has type:object and required but no properties", () => {
      const tool = makeTool({ type: "object", required: ["foo"] });
      const result = normalizeToolParameters(tool);
      expect((result.parameters as Record<string, unknown>).properties).toEqual({});
    });

    it("preserves existing properties when present", () => {
      const tool = makeTool({ type: "object", properties: { foo: { type: "string" } } });
      const result = normalizeToolParameters(tool);
      expect((result.parameters as Record<string, unknown>).properties).toEqual({
        foo: { type: "string" },
      });
    });

    it("does not inject properties for non-object types", () => {
      const tool = makeTool({ type: "string" });
      const result = normalizeToolParameters(tool);
      expect(result.parameters).toEqual({ type: "string" });
    });
  });

  describe("anyOf / oneOf union flattening", () => {
    it("flattens anyOf variants into a single object schema", () => {
      const tool = makeTool({
        anyOf: [
          { type: "object", properties: { action: { type: "string" } }, required: ["action"] },
          { type: "object", properties: { action: { type: "string" }, value: { type: "number" } } },
        ],
      });
      const result = normalizeToolParameters(tool);
      const params = result.parameters as Record<string, unknown>;
      expect(params.type).toBe("object");
      expect(params).toHaveProperty("properties");
    });
  });

  describe("no-op paths", () => {
    it("returns tool unchanged when parameters is missing", () => {
      const tool = { name: "test_tool", description: "test" } as AnyAgentTool;
      expect(normalizeToolParameters(tool)).toBe(tool);
    });

    it("returns tool with type:object + properties unchanged (no-op for non-Gemini)", () => {
      const original = { type: "object", properties: { x: { type: "number" } } };
      const tool = makeTool(original);
      const result = normalizeToolParameters(tool);
      expect(result.parameters).toEqual(original);
    });
  });
});
