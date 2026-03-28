import type { AgentTool } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { normalizeToolParameters } from "./pi-tools.schema.js";

describe("normalizeToolParameters", () => {
  it("strips compat-declared unsupported schema keywords without provider-specific branching", () => {
    const tool: AgentTool = {
      name: "demo",
      label: "demo",
      description: "demo",
      parameters: {
        type: "object",
        properties: {
          count: {
            type: "integer",
            minimum: 1,
            maximum: 5,
          },
          query: {
            type: "string",
            minLength: 2,
          },
        },
        required: ["count"],
      },
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
