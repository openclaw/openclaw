import type { AgentTool } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { sanitizeToolsForGoogle } from "./google.js";

describe("sanitizeToolsForGoogle", () => {
  it("strips unsupported schema keywords for Google providers", () => {
    const tool = {
      name: "test",
      description: "test",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          foo: {
            type: "string",
            format: "uuid",
          },
        },
      },
      execute: async () => ({ ok: true, content: [] }),
    } as unknown as AgentTool;

    const [sanitized] = sanitizeToolsForGoogle({
      tools: [tool],
      provider: "google-gemini-cli",
    });

    const params = sanitized.parameters as {
      additionalProperties?: unknown;
      properties?: Record<string, { format?: unknown }>;
    };

    expect(params.additionalProperties).toBeUndefined();
    expect(params.properties?.foo?.format).toBeUndefined();
  });

  it("preserves properties whose names match unsupported schema keywords", () => {
    const tool = {
      name: "test",
      description: "test",
      parameters: {
        type: "object",
        properties: {
          format: { type: "string" },
          pattern: { type: "string" },
          minimum: { type: "number" },
        },
      },
      execute: async () => ({ ok: true, content: [] }),
    } as unknown as AgentTool;

    const [sanitized] = sanitizeToolsForGoogle({
      tools: [tool],
      provider: "google-gemini-cli",
    });

    const params = sanitized.parameters as {
      properties?: Record<string, unknown>;
    };

    // Property NAMES that happen to match unsupported keywords must be preserved.
    // Only the keywords themselves (at the schema level) should be stripped.
    expect(params.properties?.format).toEqual({ type: "string" });
    expect(params.properties?.pattern).toEqual({ type: "string" });
    expect(params.properties?.minimum).toEqual({ type: "number" });
  });

  it("preserves keyword-named properties inside nested schemas", () => {
    const tool = {
      name: "test",
      description: "test",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                format: { type: "string" },
              },
            },
          },
        },
      },
      execute: async () => ({ ok: true, content: [] }),
    } as unknown as AgentTool;

    const [sanitized] = sanitizeToolsForGoogle({
      tools: [tool],
      provider: "google-gemini-cli",
    });

    const params = sanitized.parameters as {
      properties?: Record<string, { items?: { properties?: Record<string, unknown> } }>;
    };

    expect(params.properties?.items?.items?.properties?.format).toEqual({
      type: "string",
    });
  });
});
