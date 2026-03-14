import { describe, expect, it } from "vitest";
import { normalizeToolParameters } from "./pi-tools.schema.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

describe("normalizeToolParameters", () => {
  it("adds properties: {} when schema has type but no properties, anyOf, or oneOf", () => {
    const tool = {
      name: "my_tool",
      parameters: { type: "object" },
    } as unknown as AnyAgentTool;

    const result = normalizeToolParameters(tool);
    const params = result.parameters as Record<string, unknown>;

    expect(params).toHaveProperty("properties");
    expect(params.properties).toEqual({});
    expect(params.type).toBe("object");
  });

  it("preserves existing properties when schema already has them", () => {
    const tool = {
      name: "my_tool",
      parameters: {
        type: "object",
        properties: { foo: { type: "string" } },
      },
    } as unknown as AnyAgentTool;

    const result = normalizeToolParameters(tool);
    const params = result.parameters as Record<string, unknown>;

    expect(params.properties).toEqual({ foo: { type: "string" } });
  });

  it("returns tool unchanged when parameters is missing", () => {
    const tool = { name: "my_tool" } as unknown as AnyAgentTool;

    const result = normalizeToolParameters(tool);

    expect(result).toBe(tool);
  });

  it("returns tool unchanged when parameters is not an object", () => {
    const tool = { name: "my_tool", parameters: "not-an-object" } as unknown as AnyAgentTool;

    const result = normalizeToolParameters(tool);

    expect(result).toBe(tool);
  });

  it("handles schema with type and no variant keys (the fallthrough path)", () => {
    const tool = {
      name: "my_tool",
      parameters: { type: "object", description: "A tool" },
    } as unknown as AnyAgentTool;

    const result = normalizeToolParameters(tool);
    const params = result.parameters as Record<string, unknown>;

    expect(params.type).toBe("object");
    expect(params.description).toBe("A tool");
    expect(params.properties).toEqual({});
  });
});
