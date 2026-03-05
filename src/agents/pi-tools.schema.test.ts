import { describe, expect, it } from "vitest";
import { normalizeToolParameters } from "./pi-tools.schema.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

function makeTool(parameters: Record<string, unknown>): AnyAgentTool {
  return {
    name: "test_tool",
    description: "A test tool",
    parameters,
  } as unknown as AnyAgentTool;
}

describe("normalizeToolParameters strips constraint keywords for Ollama", () => {
  const schemaWithConstraints = {
    type: "object",
    properties: {
      label: { type: "string", minLength: 1, maxLength: 64, description: "Label" },
      items: { type: "array", items: { type: "string" }, maxItems: 50 },
    },
    required: ["label"],
  };

  it("strips maxLength/minLength/maxItems for ollama provider", () => {
    const result = normalizeToolParameters(makeTool(schemaWithConstraints), {
      modelProvider: "ollama",
    });
    const params = result.parameters as {
      properties: {
        label: Record<string, unknown>;
        items: Record<string, unknown>;
      };
    };
    expect(params.properties.label.maxLength).toBeUndefined();
    expect(params.properties.label.minLength).toBeUndefined();
    expect(params.properties.items.maxItems).toBeUndefined();
    expect(params.properties.label.type).toBe("string");
    expect(params.properties.label.description).toBe("Label");
  });

  it("strips constraint keywords for llama provider", () => {
    const result = normalizeToolParameters(makeTool(schemaWithConstraints), {
      modelProvider: "llama",
    });
    const params = result.parameters as {
      properties: { label: Record<string, unknown> };
    };
    expect(params.properties.label.maxLength).toBeUndefined();
    expect(params.properties.label.minLength).toBeUndefined();
  });

  it("preserves constraint keywords for openai provider", () => {
    const result = normalizeToolParameters(makeTool(schemaWithConstraints), {
      modelProvider: "openai",
    });
    const params = result.parameters as {
      properties: { label: Record<string, unknown> };
    };
    expect(params.properties.label.maxLength).toBe(64);
    expect(params.properties.label.minLength).toBe(1);
  });

  it("preserves constraint keywords for anthropic provider", () => {
    const result = normalizeToolParameters(makeTool(schemaWithConstraints), {
      modelProvider: "anthropic",
    });
    const params = result.parameters as {
      properties: { label: Record<string, unknown> };
    };
    expect(params.properties.label.maxLength).toBe(64);
    expect(params.properties.label.minLength).toBe(1);
  });
});
