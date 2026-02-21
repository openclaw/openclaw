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

  it("strips unsupported schema keywords for google-antigravity", () => {
    const tool = {
      name: "test",
      description: "test",
      parameters: {
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
      },
      execute: async () => ({ ok: true, content: [] }),
    } as unknown as AgentTool;

    const [sanitized] = sanitizeToolsForGoogle({
      tools: [tool],
      provider: "google-antigravity",
    });

    const params = sanitized.parameters as {
      patternProperties?: unknown;
      properties?: Record<string, { format?: unknown }>;
    };

    expect(params.patternProperties).toBeUndefined();
    expect(params.properties?.foo?.format).toBeUndefined();
  });

  it("strips unsupported schema keywords for openai-codex (routed via Cloud Code Assist)", () => {
    const tool = {
      name: "exec",
      description: "execute shell commands",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          env: {
            type: "object",
            patternProperties: {
              "^.*$": { type: "string" },
            },
          },
        },
      },
      execute: async () => ({ ok: true, content: [] }),
    } as unknown as AgentTool;

    const [sanitized] = sanitizeToolsForGoogle({
      tools: [tool],
      provider: "openai-codex",
    });

    const params = sanitized.parameters as {
      properties?: Record<string, { patternProperties?: unknown }>;
    };

    expect(params.properties?.env?.patternProperties).toBeUndefined();
  });

  it("strips unsupported schema keywords for google/* providers", () => {
    const tool = {
      name: "exec",
      description: "execute shell commands",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          env: {
            type: "object",
            patternProperties: {
              "^.*$": { type: "string" },
            },
          },
        },
      },
      execute: async () => ({ ok: true, content: [] }),
    } as unknown as AgentTool;

    const [sanitized] = sanitizeToolsForGoogle({
      tools: [tool],
      provider: "google/gemini-3-pro-preview",
    });

    const params = sanitized.parameters as {
      properties?: Record<string, { patternProperties?: unknown }>;
    };

    expect(params.properties?.env?.patternProperties).toBeUndefined();
  });
});
