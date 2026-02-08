import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
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
  const makeAssistant = (overrides: Partial<AssistantMessage>): AssistantMessage =>
    ({
      stopReason: "error",
      errorMessage: errorJson,
      content: [{ type: "text", text: errorJson }],
      ...overrides,
    }) as AssistantMessage;

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
    const payloads = buildEmbeddedRunPayloads({
      assistantTexts: [errorJsonPretty],
      toolMetas: [],
      lastAssistant: { stopReason: "end_turn" } as AssistantMessage,
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
    const payloads = buildEmbeddedRunPayloads({
      assistantTexts: ["All good"],
      toolMetas: [],
      lastAssistant: { stopReason: "end_turn" } as AssistantMessage,
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
    const payloads = buildEmbeddedRunPayloads({
      assistantTexts: [],
      toolMetas: [],
      lastAssistant: {
        stopReason: "toolUse",
        content: [
          {
            type: "toolCall",
            id: "toolu_01",
            name: "exec",
            arguments: { command: "echo hi" },
          },
        ],
      } as AssistantMessage,
      lastToolError: { toolName: "exec", error: "Command exited with code 1" },
      sessionKey: "session:telegram",
      inlineToolResultsAllowed: false,
      verboseLevel: "off",
      reasoningLevel: "off",
      toolResultFormat: "plain",
    });

    // Exec exit code errors are now suppressed as internal/recoverable errors
    expect(payloads).toHaveLength(0);
  });

  it("suppresses exec exit code errors (grep no matches, etc.)", () => {
    const payloads = buildEmbeddedRunPayloads({
      assistantTexts: [],
      toolMetas: [],
      lastAssistant: undefined,
      lastToolError: { toolName: "exec", error: "Command exited with code 1" },
      sessionKey: "session:telegram",
      inlineToolResultsAllowed: false,
      verboseLevel: "off",
      reasoningLevel: "off",
      toolResultFormat: "plain",
    });

    // Exec/bash exit code errors should not be sent to the user
    expect(payloads).toHaveLength(0);
  });

  it("suppresses bash exit code errors", () => {
    const payloads = buildEmbeddedRunPayloads({
      assistantTexts: [],
      toolMetas: [],
      lastAssistant: undefined,
      lastToolError: { toolName: "bash", error: "Command exited with code 127" },
      sessionKey: "session:telegram",
      inlineToolResultsAllowed: false,
      verboseLevel: "off",
      reasoningLevel: "off",
      toolResultFormat: "plain",
    });

    expect(payloads).toHaveLength(0);
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
