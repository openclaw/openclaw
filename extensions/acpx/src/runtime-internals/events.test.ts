import { describe, expect, it } from "vitest";
import { parsePromptEventLine, toAcpxErrorEvent } from "./events.js";

function jsonLine(payload: unknown): string {
  return JSON.stringify(payload);
}

describe("acpx runtime event parsing", () => {
  it("maps agent message chunks to output deltas", () => {
    const event = parsePromptEventLine(
      jsonLine({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "hello world",
            },
          },
        },
      }),
    );

    expect(event).toEqual({
      type: "text_delta",
      text: "hello world",
      stream: "output",
    });
  });

  it("preserves leading spaces in streamed output chunks", () => {
    const event = parsePromptEventLine(
      jsonLine({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "  indented",
            },
          },
        },
      }),
    );

    expect(event).toEqual({
      type: "text_delta",
      text: "  indented",
      stream: "output",
    });
  });

  it("maps agent thought chunks to thought deltas", () => {
    const event = parsePromptEventLine(
      jsonLine({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: {
              type: "text",
              text: "thinking",
            },
          },
        },
      }),
    );

    expect(event).toEqual({
      type: "text_delta",
      text: "thinking",
      stream: "thought",
    });
  });

  it("maps tool call updates to tool_call events", () => {
    const event = parsePromptEventLine(
      jsonLine({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "call-1",
            title: "exec",
            status: "in_progress",
          },
        },
      }),
    );

    expect(event).toEqual({
      type: "tool_call",
      text: "exec (in_progress)",
    });
  });

  it("maps prompt response stop reasons to done events", () => {
    const event = parsePromptEventLine(
      jsonLine({
        jsonrpc: "2.0",
        id: "req-1",
        result: {
          stopReason: "end_turn",
        },
      }),
    );

    expect(event).toEqual({
      type: "done",
      stopReason: "end_turn",
    });
  });

  it("maps json-rpc errors to runtime errors", () => {
    const event = parsePromptEventLine(
      jsonLine({
        jsonrpc: "2.0",
        id: "req-1",
        error: {
          code: -32000,
          message: "adapter failed",
        },
      }),
    );

    expect(event).toEqual({
      type: "error",
      message: "adapter failed",
      code: "-32000",
      retryable: undefined,
    });
  });

  it("ignores non-prompt response errors when parse context is provided", () => {
    const context = {
      promptRequestIds: new Set<string>(),
    };

    const promptRequest = parsePromptEventLine(
      jsonLine({
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: {
          sessionId: "session-1",
          prompt: [{ type: "text", text: "hello" }],
        },
      }),
      context,
    );
    const loadError = parsePromptEventLine(
      jsonLine({
        jsonrpc: "2.0",
        id: 1,
        error: {
          code: -32002,
          message: "Resource not found",
        },
      }),
      context,
    );
    const promptDone = parsePromptEventLine(
      jsonLine({
        jsonrpc: "2.0",
        id: 3,
        result: {
          stopReason: "end_turn",
        },
      }),
      context,
    );

    expect(promptRequest).toBeNull();
    expect(loadError).toBeNull();
    expect(promptDone).toEqual({
      type: "done",
      stopReason: "end_turn",
    });
  });
});

describe("toAcpxErrorEvent", () => {
  it("reads control command errors from json output", () => {
    expect(
      toAcpxErrorEvent({
        error: {
          code: "NO_SESSION",
          message: "No matching session",
          retryable: false,
        },
      }),
    ).toEqual({
      code: "NO_SESSION",
      message: "No matching session",
      retryable: false,
    });
  });
});
