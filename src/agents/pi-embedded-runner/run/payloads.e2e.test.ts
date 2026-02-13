import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { formatBillingErrorMessage } from "../../pi-embedded-helpers.js";
import { buildEmbeddedRunPayloads } from "./payloads.js";

describe("buildEmbeddedRunPayloads", () => {
  const errorJson =
    '{"type":"error","error":{"details":null,"type":"overloaded_error","message":"Overloaded"},"request_id":"req_011CX7DwS7tSvggaNHmefwWg"}';
  const errorJsonPretty = `{
  "type": "error",
  "error": {
    "details": null,
    "type": "overloaded_error",
    "message": "Overloaded"
  },
  "request_id": "req_011CX7DwS7tSvggaNHmefwWg"
}`;
  const makeAssistant = (overrides: Partial<AssistantMessage>): AssistantMessage => ({
    role: "assistant",
    api: "openai-responses",
    provider: "openai",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    timestamp: 0,
    stopReason: "error",
    errorMessage: errorJson,
    content: [{ type: "text", text: errorJson }],
    ...overrides,
  });

  it("suppresses raw API error JSON when the assistant errored", () => {
    const lastAssistant = makeAssistant({});
    const payloads = buildEmbeddedRunPayloads({
      assistantTexts: [errorJson],
      toolMetas: [],
      lastAssistant,
      sessionKey: "session:telegram",
      inlineToolResultsAllowed: false,
      verboseLevel: "off",
      reasoningLevel: "off",
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe(
      "The AI service is temporarily overloaded. Please try again in a moment.",
    );
    expect(payloads[0]?.isError).toBe(true);
    expect(payloads.some((payload) => payload.text === errorJson)).toBe(false);
  });

  it("suppresses pretty-printed error JSON that differs from the errorMessage", () => {
    const lastAssistant = makeAssistant({ errorMessage: errorJson });
    const payloads = buildEmbeddedRunPayloads({
      assistantTexts: [errorJsonPretty],
      toolMetas: [],
      lastAssistant,
      sessionKey: "session:telegram",
      inlineToolResultsAllowed: true,
      verboseLevel: "on",
      reasoningLevel: "off",
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe(
      "The AI service is temporarily overloaded. Please try again in a moment.",
    );
    expect(payloads.some((payload) => payload.text === errorJsonPretty)).toBe(false);
  });

  it("suppresses raw error JSON from fallback assistant text", () => {
    const lastAssistant = makeAssistant({ content: [{ type: "text", text: errorJsonPretty }] });
    const payloads = buildEmbeddedRunPayloads({
      assistantTexts: [],
      toolMetas: [],
      lastAssistant,
      sessionKey: "session:telegram",
      inlineToolResultsAllowed: false,
      verboseLevel: "off",
      reasoningLevel: "off",
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe(
      "The AI service is temporarily overloaded. Please try again in a moment.",
    );
    expect(payloads.some((payload) => payload.text?.includes("request_id"))).toBe(false);
  });

  it("includes provider context for billing errors", () => {
    const lastAssistant = makeAssistant({
      errorMessage: "insufficient credits",
      content: [{ type: "text", text: "insufficient credits" }],
    });
    const payloads = buildEmbeddedRunPayloads({
      assistantTexts: [],
      toolMetas: [],
      lastAssistant,
      sessionKey: "session:telegram",
      provider: "Anthropic",
      inlineToolResultsAllowed: false,
      verboseLevel: "off",
      reasoningLevel: "off",
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe(formatBillingErrorMessage("Anthropic"));
    expect(payloads[0]?.isError).toBe(true);
  });

  it("suppresses raw error JSON even when errorMessage is missing", () => {
    const lastAssistant = makeAssistant({ errorMessage: undefined });
    const payloads = buildEmbeddedRunPayloads({
      assistantTexts: [errorJsonPretty],
      toolMetas: [],
      lastAssistant,
      sessionKey: "session:telegram",
      inlineToolResultsAllowed: false,
      verboseLevel: "off",
      reasoningLevel: "off",
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.isError).toBe(true);
    expect(payloads.some((payload) => payload.text?.includes("request_id"))).toBe(false);
  });

  it("does not suppress error-shaped JSON when the assistant did not error", () => {
    const lastAssistant = makeAssistant({
      stopReason: "stop",
      errorMessage: undefined,
      content: [],
    });
    const payloads = buildEmbeddedRunPayloads({
      assistantTexts: [errorJsonPretty],
      toolMetas: [],
      lastAssistant,
      sessionKey: "session:telegram",
      inlineToolResultsAllowed: false,
      verboseLevel: "off",
      reasoningLevel: "off",
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe(errorJsonPretty.trim());
  });

  it("adds a fallback error when a tool fails and no assistant output exists", () => {
    const payloads = buildEmbeddedRunPayloads({
      assistantTexts: [],
      toolMetas: [],
      lastAssistant: undefined,
      lastToolError: { toolName: "browser", error: "tab not found" },
      sessionKey: "session:telegram",
      inlineToolResultsAllowed: false,
      verboseLevel: "off",
      reasoningLevel: "off",
      toolResultFormat: "plain",
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.isError).toBe(true);
    expect(payloads[0]?.text).toContain("Browser");
    expect(payloads[0]?.text).toContain("tab not found");
  });

  it("does not add tool error fallback when assistant output exists", () => {
    const lastAssistant = makeAssistant({
      stopReason: "stop",
      errorMessage: undefined,
      content: [],
    });
    const payloads = buildEmbeddedRunPayloads({
      assistantTexts: ["All good"],
      toolMetas: [],
      lastAssistant,
      lastToolError: { toolName: "browser", error: "tab not found" },
      sessionKey: "session:telegram",
      inlineToolResultsAllowed: false,
      verboseLevel: "off",
      reasoningLevel: "off",
      toolResultFormat: "plain",
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe("All good");
  });

  it("adds tool error fallback when the assistant only invoked tools", () => {
    const lastAssistant = makeAssistant({
      stopReason: "toolUse",
      errorMessage: undefined,
      content: [
        {
          type: "toolCall",
          id: "toolu_01",
          name: "exec",
          arguments: { command: "echo hi" },
        },
      ],
    });
    const payloads = buildEmbeddedRunPayloads({
      assistantTexts: [],
      toolMetas: [],
      lastAssistant,
      lastToolError: { toolName: "exec", error: "Command exited with code 1" },
      sessionKey: "session:telegram",
      inlineToolResultsAllowed: false,
      verboseLevel: "off",
      reasoningLevel: "off",
      toolResultFormat: "plain",
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.isError).toBe(true);
    expect(payloads[0]?.text).toContain("Exec");
    expect(payloads[0]?.text).toContain("code 1");
  });

  it("suppresses recoverable tool errors containing 'required'", () => {
    const payloads = buildEmbeddedRunPayloads({
      assistantTexts: [],
      toolMetas: [],
      lastAssistant: undefined,
      lastToolError: { toolName: "message", meta: "reply", error: "text required" },
      sessionKey: "session:telegram",
      inlineToolResultsAllowed: false,
      verboseLevel: "off",
      reasoningLevel: "off",
      toolResultFormat: "plain",
    });

    // Recoverable errors should not be sent to the user
    expect(payloads).toHaveLength(0);
  });

  it("suppresses recoverable tool errors containing 'missing'", () => {
    const payloads = buildEmbeddedRunPayloads({
      assistantTexts: [],
      toolMetas: [],
      lastAssistant: undefined,
      lastToolError: { toolName: "message", error: "messageId missing" },
      sessionKey: "session:telegram",
      inlineToolResultsAllowed: false,
      verboseLevel: "off",
      reasoningLevel: "off",
      toolResultFormat: "plain",
    });

    expect(payloads).toHaveLength(0);
  });

  it("suppresses recoverable tool errors containing 'invalid'", () => {
    const payloads = buildEmbeddedRunPayloads({
      assistantTexts: [],
      toolMetas: [],
      lastAssistant: undefined,
      lastToolError: { toolName: "message", error: "invalid parameter: to" },
      sessionKey: "session:telegram",
      inlineToolResultsAllowed: false,
      verboseLevel: "off",
      reasoningLevel: "off",
      toolResultFormat: "plain",
    });

    expect(payloads).toHaveLength(0);
  });

  it("shows non-recoverable tool errors to the user", () => {
    const payloads = buildEmbeddedRunPayloads({
      assistantTexts: [],
      toolMetas: [],
      lastAssistant: undefined,
      lastToolError: { toolName: "browser", error: "connection timeout" },
      sessionKey: "session:telegram",
      inlineToolResultsAllowed: false,
      verboseLevel: "off",
      reasoningLevel: "off",
      toolResultFormat: "plain",
    });

    // Non-recoverable errors should still be shown
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.isError).toBe(true);
    expect(payloads[0]?.text).toContain("connection timeout");
  });
});
