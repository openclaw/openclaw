import { describe, expect, it } from "vitest";
import type { AnyAgentTool } from "./pi-tools.schema.js";
import { normalizeToolParameters } from "./pi-tools.schema.js";

describe("normalizeToolParameters", () => {
  it("adds empty properties when schema has type but no properties/anyOf/oneOf (#20224)", () => {
    const tool = {
      name: "my_tool",
      description: "A tool",
      parameters: { type: "object" },
    } as unknown as AnyAgentTool;

    const result = normalizeToolParameters(tool);
    const params = result.parameters as Record<string, unknown>;
    expect(params.type).toBe("object");
    expect(params.properties).toEqual({});
  });

  it("preserves existing properties when present", () => {
    const tool = {
      name: "my_tool",
      description: "A tool",
      parameters: { type: "object", properties: { foo: { type: "string" } } },
    } as unknown as AnyAgentTool;

    const result = normalizeToolParameters(tool);
    const params = result.parameters as Record<string, unknown>;
    expect(params.properties).toEqual({ foo: { type: "string" } });
  });

  it("returns tool unchanged when no parameters", () => {
    const tool = { name: "my_tool", description: "A tool" } as unknown as AnyAgentTool;
    const result = normalizeToolParameters(tool);
    expect(result).toBe(tool);
  });
});
