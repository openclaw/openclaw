import { describe, expect, it } from "vitest";
import { normalizeToolParameters } from "./pi-tools.schema.js";

describe("normalizeToolParameters", () => {
  it("strips top-level required: null", () => {
    const tool = {
      name: "test_tool",
      description: "test",
      parameters: {
        type: "object",
        properties: { foo: { type: "string" } },
        required: null,
      },
    };
    const result = normalizeToolParameters(tool);
    const params = result.parameters as Record<string, unknown>;
    expect(params).not.toHaveProperty("required");
    expect(params.type).toBe("object");
    expect(params.properties).toEqual({ foo: { type: "string" } });
  });

  it("preserves valid required array", () => {
    const tool = {
      name: "test_tool",
      description: "test",
      parameters: {
        type: "object",
        properties: { foo: { type: "string" } },
        required: ["foo"],
      },
    };
    const result = normalizeToolParameters(tool);
    const params = result.parameters as Record<string, unknown>;
    expect(params.required).toEqual(["foo"]);
  });

  it("strips required: undefined-like values (non-array)", () => {
    const tool = {
      name: "test_tool",
      description: "test",
      parameters: {
        type: "object",
        properties: { bar: { type: "number" } },
        required: "bar",
      },
    };
    const result = normalizeToolParameters(tool);
    const params = result.parameters as Record<string, unknown>;
    expect(params).not.toHaveProperty("required");
  });

  it("handles required: null with Gemini provider", () => {
    const tool = {
      name: "test_tool",
      description: "test",
      parameters: {
        type: "object",
        properties: { foo: { type: "string" } },
        required: null,
      },
    };
    const result = normalizeToolParameters(tool, { modelProvider: "google" });
    const params = result.parameters as Record<string, unknown>;
    expect(params).not.toHaveProperty("required");
  });

  it("returns tool unchanged when parameters is absent", () => {
    const tool = { name: "test_tool", description: "test" };
    const result = normalizeToolParameters(tool);
    expect(result).toEqual(tool);
  });
});
