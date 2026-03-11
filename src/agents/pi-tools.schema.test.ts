import { describe, expect, it } from "vitest";
import { normalizeToolParameters } from "./pi-tools.schema.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

function makeTool(params?: Record<string, unknown>): AnyAgentTool {
  return {
    name: "test_tool",
    description: "test",
    label: "Test",
    execute: () => Promise.resolve({ content: [], details: undefined }),
    ...(params !== undefined ? { parameters: params } : {}),
  } as AnyAgentTool;
}

describe("normalizeToolParameters", () => {
  it("strips top-level required: null", () => {
    const tool = makeTool({
      type: "object",
      properties: { foo: { type: "string" } },
      required: null,
    });
    const result = normalizeToolParameters(tool);
    const params = result.parameters as Record<string, unknown>;
    expect(params).not.toHaveProperty("required");
    expect(params.type).toBe("object");
    expect(params.properties).toEqual({ foo: { type: "string" } });
  });

  it("preserves valid required array", () => {
    const tool = makeTool({
      type: "object",
      properties: { foo: { type: "string" } },
      required: ["foo"],
    });
    const result = normalizeToolParameters(tool);
    const params = result.parameters as Record<string, unknown>;
    expect(params.required).toEqual(["foo"]);
  });

  it("strips required: undefined-like values (non-array)", () => {
    const tool = makeTool({
      type: "object",
      properties: { bar: { type: "number" } },
      required: "bar",
    });
    const result = normalizeToolParameters(tool);
    const params = result.parameters as Record<string, unknown>;
    expect(params).not.toHaveProperty("required");
  });

  it("handles required: null with Gemini provider", () => {
    const tool = makeTool({
      type: "object",
      properties: { foo: { type: "string" } },
      required: null,
    });
    const result = normalizeToolParameters(tool, { modelProvider: "google" });
    const params = result.parameters as Record<string, unknown>;
    expect(params).not.toHaveProperty("required");
  });

  it("strips nested required: null inside properties for Gemini provider", () => {
    const tool = makeTool({
      type: "object",
      properties: {
        address: {
          type: "object",
          properties: { street: { type: "string" } },
          required: null,
        },
      },
      required: ["address"],
    });
    const result = normalizeToolParameters(tool, { modelProvider: "google" });
    const props = (result.parameters as Record<string, unknown>).properties as Record<
      string,
      unknown
    >;
    expect(props.address).not.toHaveProperty("required");
    expect((result.parameters as Record<string, unknown>).required).toEqual(["address"]);
  });

  it("returns tool unchanged when parameters is absent", () => {
    const tool = makeTool();
    const result = normalizeToolParameters(tool);
    expect(result).toEqual(tool);
  });
});
