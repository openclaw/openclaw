import type { AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  formatAimlapiToolSchemaError,
  isAimlapiInvalidToolSchemaError,
  normalizeAimlapiAssistantNullContent,
  normalizeAimlapiPayloadNullContent,
  sanitizeToolsForAimlapi,
} from "./aimlapi.js";

describe("sanitizeToolsForAimlapi", () => {
  it("removes unsupported keywords and forces object root schema", () => {
    const tool = {
      name: "test",
      description: "test",
      parameters: {
        anyOf: [{ type: "object", properties: { foo: { type: "string", format: "uuid" } } }],
        properties: {
          option: {
            oneOf: [
              { const: "a", type: "string" },
              { const: "b", type: "string" },
            ],
            minLength: 1,
          },
        },
        additionalProperties: false,
      },
      execute: async () => ({ ok: true, content: [] }),
    } as unknown as AgentTool;

    const [sanitized] = sanitizeToolsForAimlapi({ tools: [tool], provider: "aimlapi" });
    const params = sanitized.parameters as {
      type?: unknown;
      properties?: Record<string, { oneOf?: unknown; minLength?: unknown; enum?: unknown[] }>;
      anyOf?: unknown;
      additionalProperties?: unknown;
    };

    expect(params.type).toBe("object");
    expect(params.anyOf).toBeUndefined();
    expect(params.additionalProperties).toBeUndefined();
    expect(params.properties?.option?.oneOf).toBeUndefined();
    expect(params.properties?.option?.minLength).toBeUndefined();
    expect(params.properties?.option?.enum).toEqual(["a", "b"]);
  });
});

describe("AIMLAPI invalid schema error helpers", () => {
  it("detects provider schema errors", () => {
    expect(
      isAimlapiInvalidToolSchemaError(
        "HTTP 400: AIMLAPI Invalid payload provided (invalid tool schema)",
      ),
    ).toBe(true);
    expect(
      isAimlapiInvalidToolSchemaError("HTTP 400: Invalid payload provided (invalid tool schema)"),
    ).toBe(true);
    expect(isAimlapiInvalidToolSchemaError("rate limited")).toBe(false);
  });

  it("formats detailed error message", () => {
    const formatted = formatAimlapiToolSchemaError(
      "Invalid payload provided (invalid tool schema)",
    );
    expect(formatted).toContain("AIMLAPI rejected the tool schema (HTTP 400)");
    expect(formatted).toContain("Invalid payload provided");
  });
});

describe("normalizeAimlapiAssistantNullContent", () => {
  it("replaces assistant null content with empty string for aimlapi", () => {
    const normalized = normalizeAimlapiAssistantNullContent({
      provider: "aimlapi",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: null, toolCalls: [{ id: "x" }] },
      ] as AgentMessage[],
    });
    expect(normalized.replacedCount).toBe(1);
    expect((normalized.messages[1] as { content?: unknown }).content).toBe("");
  });

  it("does not modify non-aimlapi providers", () => {
    const original = [{ role: "assistant", content: null }] as unknown as AgentMessage[];
    const normalized = normalizeAimlapiAssistantNullContent({
      provider: "openai",
      messages: original,
    });
    expect(normalized.replacedCount).toBe(0);
    expect(normalized.messages).toBe(original);
  });
});

describe("normalizeAimlapiPayloadNullContent", () => {
  it("rewrites assistant null content in payload messages", () => {
    const payload = {
      messages: [
        { role: "assistant", content: null, tool_calls: [{ id: "call_1" }] },
        { role: "user", content: "ok" },
      ],
    };
    const result = normalizeAimlapiPayloadNullContent({ provider: "aimlapi", payload });
    expect(result.replacedCount).toBe(1);
    expect((payload.messages[0] as { content?: unknown }).content).toBe("");
  });
});
