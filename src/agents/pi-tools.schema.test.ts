import { describe, expect, it } from "vitest";
import { normalizeToolParameters } from "./pi-tools.schema.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

function makeTool(parameters: unknown): AnyAgentTool {
  return {
    name: "test_tool",
    label: "Test Tool",
    description: "test",
    parameters,
    execute: async () => ({ content: [], details: {} }),
  } as unknown as AnyAgentTool;
}

describe("normalizeToolParameters", () => {
  it("filters required to match properties when flattening anyOf for Gemini", () => {
    const tool = makeTool({
      type: "object",
      required: ["action", "amount", "token"],
      anyOf: [
        {
          type: "object",
          properties: {
            action: { type: "string", enum: ["buy"] },
            amount: { type: "number" },
          },
        },
        {
          type: "object",
          properties: {
            action: { type: "string", enum: ["sell"] },
            price: { type: "number" },
          },
        },
      ],
    });

    const result = normalizeToolParameters(tool, {
      modelProvider: "google",
    });

    const params = result.parameters as {
      required?: string[];
      properties?: Record<string, unknown>;
    };
    // "token" is not in any variant's properties, should be filtered out
    expect(params.required).not.toContain("token");
    // "action" and "amount" are in properties, should be kept
    expect(params.required).toContain("action");
    expect(params.properties).toHaveProperty("action");
    expect(params.properties).toHaveProperty("amount");
    expect(params.properties).toHaveProperty("price");
  });

  it("keeps all required fields when they exist in merged properties", () => {
    const tool = makeTool({
      type: "object",
      required: ["action", "amount"],
      anyOf: [
        {
          type: "object",
          properties: {
            action: { type: "string" },
            amount: { type: "number" },
          },
        },
      ],
    });

    const result = normalizeToolParameters(tool, {
      modelProvider: "google",
    });

    const params = result.parameters as { required?: string[] };
    expect(params.required).toContain("action");
    expect(params.required).toContain("amount");
  });

  it("removes required entirely when no fields match merged properties", () => {
    const tool = makeTool({
      type: "object",
      required: ["ghost_a", "ghost_b"],
      anyOf: [
        {
          type: "object",
          properties: {
            real: { type: "string" },
          },
        },
      ],
    });

    const result = normalizeToolParameters(tool, {
      modelProvider: "google",
    });

    const params = result.parameters as { required?: string[] };
    // All required fields are missing from properties — required should be absent or empty
    expect(params.required ?? []).toEqual([]);
  });
});
