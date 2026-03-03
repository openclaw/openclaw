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

  it.each(["google", "google-gemini-cli", "google-antigravity", "google-generative-ai"] as const)(
    "strips unsupported schema keywords for provider %s",
    (provider) => {
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
        provider,
      });
      expectFormatRemoved(sanitized, "additionalProperties");
    },
  );

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
