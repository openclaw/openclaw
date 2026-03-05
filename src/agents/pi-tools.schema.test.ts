import { describe, expect, it } from "vitest";
import { normalizeToolParameters } from "./pi-tools.schema.js";

const createTool = (parameters: Record<string, unknown>) =>
  ({
    name: "test",
    description: "test",
    parameters,
    execute: async () => ({ ok: true, content: [] }),
  }) as unknown;

describe("normalizeToolParameters", () => {
  it("cleans Gemini-incompatible keywords for openrouter gemini proxy models", () => {
    const tool = createTool({
      type: "object",
      properties: {
        value: {
          type: "object",
          patternProperties: {
            "^x-": {
              type: "string",
            },
          },
          properties: {
            mode: {
              type: "string",
              minLength: 1,
            },
          },
        },
      },
      required: ["value"],
    }) as Parameters<typeof normalizeToolParameters>[0];

    const normalized = normalizeToolParameters(tool, {
      modelProvider: "openrouter",
      modelId: "google/gemini-3-flash-preview",
    });
    const params = normalized.parameters as {
      properties?: Record<string, { patternProperties?: unknown; minLength?: unknown; properties?: Record<string, unknown> }>;
    };
    const value = params.properties?.value as
      | {
          patternProperties?: unknown;
          properties?: Record<string, { minLength?: unknown }>;
        }
      | undefined;

    expect(value?.patternProperties).toBeUndefined();
    expect(value?.properties?.mode?.minLength).toBeUndefined();
  });

  it("does not clean non-Gemini models", () => {
    const tool = createTool({
      type: "object",
      properties: {
        value: {
          type: "string",
          patternProperties: {
            "^x-": {
              type: "string",
            },
          },
        },
      },
    }) as Parameters<typeof normalizeToolParameters>[0];

    const normalized = normalizeToolParameters(tool, {
      modelProvider: "openrouter",
      modelId: "anthropic/claude-opus-4-5",
    });
    const params = normalized.parameters as { properties?: Record<string, { patternProperties?: unknown }> };

    expect(params.properties?.value?.patternProperties).toBeDefined();
  });
});
