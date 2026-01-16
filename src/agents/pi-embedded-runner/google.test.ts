import { describe, expect, it } from "vitest";

import type { AgentTool } from "@mariozechner/pi-agent-core";
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
});
