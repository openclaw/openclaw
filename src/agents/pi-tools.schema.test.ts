import { Type } from "@sinclair/typebox";
import { describe, expect, it, vi } from "vitest";
import { normalizeToolParameters } from "./pi-tools.schema.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

describe("normalizeToolParameters", () => {
  it("strips patternProperties for non-Anthropic providers by default (#57443)", () => {
    const tool: AnyAgentTool = {
      name: "exec",
      label: "exec",
      description: "run a command",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          env: {
            type: "object",
            patternProperties: {
              "^(.*)$": { type: "string" },
            },
          },
        },
        required: ["command"],
      },
      execute: vi.fn(),
    };

    // Non-Anthropic provider (e.g. BytePlus Ark) should strip patternProperties
    const normalized = normalizeToolParameters(tool, {
      modelProvider: "bytedance",
    });
    const env = (normalized.parameters as Record<string, unknown>).properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(env.env.patternProperties).toBeUndefined();
    expect(env.env.type).toBe("object");

    // Anthropic native API supports full JSON Schema — keep patternProperties
    const anthropicNormalized = normalizeToolParameters(tool, {
      modelProvider: "anthropic",
    });
    const anthropicEnv = (anthropicNormalized.parameters as Record<string, unknown>)
      .properties as Record<string, Record<string, unknown>>;
    expect(anthropicEnv.env.patternProperties).toBeDefined();
  });

  it("strips compat-declared unsupported schema keywords without provider-specific branching", () => {
    const tool: AnyAgentTool = {
      name: "demo",
      label: "demo",
      description: "demo",
      parameters: Type.Object({
        count: Type.Integer({ minimum: 1, maximum: 5 }),
        query: Type.Optional(Type.String({ minLength: 2 })),
      }),
      execute: vi.fn(),
    };

    const normalized = normalizeToolParameters(tool, {
      modelCompat: {
        unsupportedToolSchemaKeywords: ["minimum", "maximum", "minLength"],
      },
    });

    const parameters = normalized.parameters as {
      required?: string[];
      properties?: Record<string, Record<string, unknown>>;
    };

    expect(parameters.required).toEqual(["count"]);
    expect(parameters.properties?.count.minimum).toBeUndefined();
    expect(parameters.properties?.count.maximum).toBeUndefined();
    expect(parameters.properties?.count.type).toBe("integer");
    expect(parameters.properties?.query.minLength).toBeUndefined();
    expect(parameters.properties?.query.type).toBe("string");
  });
});
