import { describe, expect, it } from "vitest";
import { normalizeToolParameters } from "./pi-tools.schema.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

function makeTool(parameters: unknown): AnyAgentTool {
  return { name: "test_tool", description: "test", parameters } as AnyAgentTool;
}

describe("normalizeToolParameters", () => {
  it("returns tool unchanged when parameters is absent", () => {
    const tool = { name: "t", description: "d" } as AnyAgentTool;
    expect(normalizeToolParameters(tool)).toBe(tool);
  });

  it("returns tool unchanged when parameters is not an object", () => {
    const tool = makeTool("invalid");
    expect(normalizeToolParameters(tool)).toBe(tool);
  });

  it("returns tool unchanged when schema already has type and properties", () => {
    const params = { type: "object", properties: { x: { type: "string" } } };
    const tool = makeTool(params);
    const result = normalizeToolParameters(tool);
    expect(result.parameters).toBe(params);
  });

  it("converts array-format parameters to JSON Schema", () => {
    const tool = makeTool([
      { name: "command", type: "string", description: "Command to run", required: true },
      { name: "target", type: "string", description: "Target", required: false },
    ]);
    const result = normalizeToolParameters(tool);
    const schema = result.parameters as Record<string, unknown>;
    expect(schema.type).toBe("object");
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.command).toMatchObject({ type: "string", description: "Command to run" });
    expect(props.target).toMatchObject({ type: "string", description: "Target" });
    expect(schema.required).toEqual(["command"]);
  });

  it("converts array params with no required fields and omits required key", () => {
    const tool = makeTool([{ name: "query", type: "string", required: false }]);
    const result = normalizeToolParameters(tool);
    const schema = result.parameters as Record<string, unknown>;
    expect(schema.type).toBe("object");
    expect(schema.required).toBeUndefined();
  });

  it("skips array entries without a name", () => {
    const tool = makeTool([null, { type: "string" }, { name: "valid", type: "number" }]);
    const result = normalizeToolParameters(tool);
    const schema = result.parameters as Record<string, unknown>;
    const props = schema.properties as Record<string, unknown>;
    expect(Object.keys(props)).toEqual(["valid"]);
  });

  it("converts array params and applies Gemini cleaning", () => {
    const tool = makeTool([{ name: "q", type: "string", description: "Query" }]);
    const result = normalizeToolParameters(tool, { modelProvider: "google" });
    const schema = result.parameters as Record<string, unknown>;
    expect(schema.type).toBe("object");
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.q?.type).toBe("string");
  });

  it("merges anyOf variants into a flat object schema", () => {
    const tool = makeTool({
      anyOf: [
        { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
        { type: "object", properties: { b: { type: "number" } }, required: ["b"] },
      ],
    });
    const result = normalizeToolParameters(tool);
    const schema = result.parameters as Record<string, unknown>;
    expect(schema.type).toBe("object");
    const props = schema.properties as Record<string, unknown>;
    expect(props).toHaveProperty("a");
    expect(props).toHaveProperty("b");
  });

  it("forces type:object when schema has properties but no type", () => {
    const tool = makeTool({ properties: { x: { type: "string" } } });
    const result = normalizeToolParameters(tool);
    const schema = result.parameters as Record<string, unknown>;
    expect(schema.type).toBe("object");
  });
});
