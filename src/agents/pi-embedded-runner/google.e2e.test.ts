import type { AgentTool } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { sanitizeToolsForGoogle } from "./google.js";

describe("sanitizeToolsForGoogle", () => {
  const createTool = (parameters: Record<string, unknown>) =>
    ({
      name: "test",
      description: "test",
      parameters,
      execute: async () => ({ ok: true, content: [] }),
    }) as unknown as AgentTool;

  const expectFormatRemoved = (
    sanitized: AgentTool,
    key: "additionalProperties" | "patternProperties",
  ) => {
    const params = sanitized.parameters as {
      additionalProperties?: unknown;
      patternProperties?: unknown;
      properties?: Record<string, { format?: unknown }>;
    };
    expect(params[key]).toBeUndefined();
    expect(params.properties?.foo?.format).toBeUndefined();
  };

  it("strips unsupported schema keywords for Google providers", () => {
    const tool = createTool({
      type: "object",
      additionalProperties: false,
      properties: {
        foo: {
          type: "string",
          format: "uuid",
        },
      },
    });
    const [sanitized] = sanitizeToolsForGoogle({
      tools: [tool],
      provider: "google-gemini-cli",
    });
    expectFormatRemoved(sanitized, "additionalProperties");
  });

  it("strips unsupported schema keywords for google-antigravity", () => {
    const tool = createTool({
      type: "object",
      patternProperties: {
        "^x-": { type: "string" },
      },
      properties: {
        foo: {
          type: "string",
          format: "uuid",
        },
      },
    });
    const [sanitized] = sanitizeToolsForGoogle({
      tools: [tool],
      provider: "google-antigravity",
    });
    expectFormatRemoved(sanitized, "patternProperties");
  });

  it("returns original tools for non-google providers", () => {
    const tool = createTool({
      type: "object",
      additionalProperties: false,
      properties: {
        foo: {
          type: "string",
          format: "uuid",
        },
      },
    });
    const sanitized = sanitizeToolsForGoogle({
      tools: [tool],
      provider: "openai",
    });

    expect(sanitized).toEqual([tool]);
    expect(sanitized[0]).toBe(tool);
  });
});
