import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { formatBillingErrorMessage } from "../../pi-embedded-helpers.js";
import { makeAssistantMessageFixture } from "../../test-helpers/assistant-message-fixtures.js";
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
    makeAssistantMessageFixture({
      errorMessage: errorJson,
      content: [{ type: "text", text: errorJson }],
      ...overrides,
    });

  type BuildPayloadParams = Parameters<typeof buildEmbeddedRunPayloads>[0];
  const buildPayloads = (overrides: Partial<BuildPayloadParams> = {}) =>
    buildEmbeddedRunPayloads({
      assistantTexts: [],
      toolMetas: [],
      lastAssistant: undefined,
      sessionKey: "session:telegram",
      inlineToolResultsAllowed: false,
      verboseLevel: "off",
      reasoningLevel: "off",
      toolResultFormat: "plain",
      ...overrides,
    });

  it("suppresses raw API error JSON when the assistant errored", () => {
    const payloads = buildPayloads({
      assistantTexts: [errorJson],
      lastAssistant: makeAssistant({}),
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe(
      "The AI service is temporarily overloaded. Please try again in a moment.",
    );
    expect(payloads[0]?.isError).toBe(true);
    expect(payloads.some((payload) => payload.text === errorJson)).toBe(false);
  });

  it("suppresses pretty-printed error JSON that differs from the errorMessage", () => {
    const payloads = buildPayloads({
      assistantTexts: [errorJsonPretty],
      lastAssistant: makeAssistant({ errorMessage: errorJson }),
      inlineToolResultsAllowed: true,
      verboseLevel: "on",
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe(
      "The AI service is temporarily overloaded. Please try again in a moment.",
    );
    expect(payloads.some((payload) => payload.text === errorJsonPretty)).toBe(false);
  });

  it("suppresses raw error JSON from fallback assistant text", () => {
    const payloads = buildPayloads({
      lastAssistant: makeAssistant({ content: [{ type: "text", text: errorJsonPretty }] }),
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe(
      "The AI service is temporarily overloaded. Please try again in a moment.",
    );
    expect(payloads.some((payload) => payload.text?.includes("request_id"))).toBe(false);
  });

  it("includes provider and model context for billing errors", () => {
    const payloads = buildPayloads({
      lastAssistant: makeAssistant({
        model: "claude-3-5-sonnet",
        errorMessage: "insufficient credits",
        content: [{ type: "text", text: "insufficient credits" }],
      }),
      provider: "Anthropic",
      model: "claude-3-5-sonnet",
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe(formatBillingErrorMessage("Anthropic", "claude-3-5-sonnet"));
    expect(payloads[0]?.isError).toBe(true);
  });

  it("suppresses raw error JSON even when errorMessage is missing", () => {
    const payloads = buildPayloads({
      assistantTexts: [errorJsonPretty],
      lastAssistant: makeAssistant({ errorMessage: undefined }),
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.isError).toBe(true);
    expect(payloads.some((payload) => payload.text?.includes("request_id"))).toBe(false);
  });

  it("does not suppress error-shaped JSON when the assistant did not error", () => {
    const payloads = buildPayloads({
      assistantTexts: [errorJsonPretty],
      lastAssistant: makeAssistant({
        stopReason: "stop",
        errorMessage: undefined,
        content: [],
      }),
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe(errorJsonPretty.trim());
  });

  it("adds a fallback error when a tool fails and no assistant output exists", () => {
    const payloads = buildPayloads({
      lastToolError: { toolName: "browser", error: "tab not found" },
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.isError).toBe(true);
    expect(payloads[0]?.text).toContain("Browser");
    expect(payloads[0]?.text).toContain("tab not found");
  });

  it("does not add tool error fallback when assistant output exists", () => {
    const payloads = buildPayloads({
      assistantTexts: ["All good"],
      lastAssistant: makeAssistant({
        stopReason: "stop",
        errorMessage: undefined,
        content: [],
      }),
      lastToolError: { toolName: "browser", error: "tab not found" },
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe("All good");
  });

  it("adds tool error fallback when the assistant only invoked tools and verbose mode is on", () => {
    const payloads = buildPayloads({
      lastAssistant: makeAssistant({
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
      }),
      lastToolError: { toolName: "exec", error: "Command exited with code 1" },
      verboseLevel: "on",
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.isError).toBe(true);
    expect(payloads[0]?.text).toContain("Exec");
    expect(payloads[0]?.text).toContain("code 1");
  });

  it("does not add tool error fallback when assistant text exists after tool calls", () => {
    const payloads = buildPayloads({
      assistantTexts: ["Checked the page and recovered with final answer."],
      lastAssistant: makeAssistant({
        stopReason: "toolUse",
        errorMessage: undefined,
        content: [
          {
            type: "toolCall",
            id: "toolu_01",
            name: "browser",
            arguments: { action: "search", query: "openclaw docs" },
          },
        ],
      }),
      lastToolError: { toolName: "browser", error: "connection timeout" },
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.isError).toBeUndefined();
    expect(payloads[0]?.text).toContain("recovered");
  });

  it("suppresses recoverable tool errors containing 'required' for non-mutating tools", () => {
    const payloads = buildPayloads({
      lastToolError: { toolName: "browser", error: "url required" },
    });

    // Recoverable errors should not be sent to the user
    expect(payloads).toHaveLength(0);
  });

  it("suppresses recoverable tool errors containing 'missing' for non-mutating tools", () => {
    const payloads = buildPayloads({
      lastToolError: { toolName: "browser", error: "url missing" },
    });

    expect(payloads).toHaveLength(0);
  });

  it("suppresses recoverable tool errors containing 'invalid' for non-mutating tools", () => {
    const payloads = buildPayloads({
      lastToolError: { toolName: "browser", error: "invalid parameter: url" },
    });

    expect(payloads).toHaveLength(0);
  });

  it("suppresses non-mutating non-recoverable tool errors when messages.suppressToolErrors is enabled", () => {
    const payloads = buildPayloads({
      lastToolError: { toolName: "browser", error: "connection timeout" },
      config: { messages: { suppressToolErrors: true } },
    });

    expect(payloads).toHaveLength(0);
  });

  it("still shows mutating tool errors when messages.suppressToolErrors is enabled", () => {
    const payloads = buildPayloads({
      lastToolError: { toolName: "write", error: "connection timeout" },
      config: { messages: { suppressToolErrors: true } },
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.isError).toBe(true);
    expect(payloads[0]?.text).toContain("connection timeout");
  });

  it("suppresses mutating tool errors when suppressToolErrorWarnings is enabled", () => {
    const payloads = buildPayloads({
      lastToolError: { toolName: "exec", error: "command not found" },
      suppressToolErrorWarnings: true,
    });

    expect(payloads).toHaveLength(0);
  });

  it("shows recoverable tool errors for mutating tools", () => {
    const payloads = buildPayloads({
      lastToolError: { toolName: "message", meta: "reply", error: "text required" },
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.isError).toBe(true);
    expect(payloads[0]?.text).toContain("required");
  });

  it("shows mutating tool errors even when assistant output exists", () => {
    const payloads = buildPayloads({
      assistantTexts: ["Done."],
      lastAssistant: { stopReason: "end_turn" } as unknown as AssistantMessage,
      lastToolError: { toolName: "write", error: "file missing" },
    });

    expect(payloads).toHaveLength(2);
    expect(payloads[0]?.text).toBe("Done.");
    expect(payloads[1]?.isError).toBe(true);
    expect(payloads[1]?.text).toContain("missing");
  });

  it("does not treat session_status read failures as mutating when explicitly flagged", () => {
    const payloads = buildPayloads({
      assistantTexts: ["Status loaded."],
      lastAssistant: { stopReason: "end_turn" } as unknown as AssistantMessage,
      lastToolError: {
        toolName: "session_status",
        error: "model required",
        mutatingAction: false,
      },
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe("Status loaded.");
  });

  it("dedupes identical tool warning text already present in assistant output", () => {
    const seed = buildPayloads({
      lastToolError: {
        toolName: "write",
        error: "file missing",
        mutatingAction: true,
      },
    });
    const warningText = seed[0]?.text;
    expect(warningText).toBeTruthy();

    const payloads = buildPayloads({
      assistantTexts: [warningText ?? ""],
      lastAssistant: { stopReason: "end_turn" } as unknown as AssistantMessage,
      lastToolError: {
        toolName: "write",
        error: "file missing",
        mutatingAction: true,
      },
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe(warningText);
  });

  it("shows non-recoverable tool errors to the user", () => {
    const payloads = buildPayloads({
      lastToolError: { toolName: "browser", error: "connection timeout" },
    });

    // Non-recoverable errors should still be shown
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.isError).toBe(true);
    expect(payloads[0]?.text).toContain("connection timeout");
  });
});
