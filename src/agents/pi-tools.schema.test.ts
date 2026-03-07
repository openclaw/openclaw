import { describe, expect, it } from "vitest";
import { normalizeToolParameters } from "./pi-tools.schema.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

function createToolWithPatternProperties(): AnyAgentTool {
  return {
    name: "test-tool",
    description: "test tool",
    parameters: {
      type: "object",
      properties: {
        value: {
          type: "object",
          patternProperties: {
            ".*": { type: "string" },
          },
        },
      },
    },
  } as unknown as AnyAgentTool;
}

describe("normalizeToolParameters schema compatibility", () => {
  it("cleans Gemini-incompatible keywords for google-antigravity", () => {
    const tool = createToolWithPatternProperties();

    const normalized = normalizeToolParameters(tool, {
      modelProvider: "google-antigravity",
    });

    const parameters = normalized.parameters as {
      properties?: { value?: { patternProperties?: unknown } };
    };
    expect(parameters.properties?.value?.patternProperties).toBeUndefined();
  });

  it("preserves full schema for non-google anthropic provider", () => {
    const tool = createToolWithPatternProperties();

    const normalized = normalizeToolParameters(tool, {
      modelProvider: "anthropic",
    });

    const parameters = normalized.parameters as {
      properties?: { value?: { patternProperties?: unknown } };
    };
    expect(parameters.properties?.value?.patternProperties).toBeDefined();
  });
});
