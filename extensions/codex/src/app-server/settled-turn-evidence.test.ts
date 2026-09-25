import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it } from "vitest";
import { CodexHistoryRejection } from "./history-rejection.js";
import { projectVerifiedSettledCodexMessages } from "./settled-turn-evidence.js";
import { attachCodexMirrorIdentity } from "./upstream-prompt-provenance.js";

const failure = JSON.stringify({
  error: "HTTP 429 Too Many Requests: the service rate limit was exceeded.",
  error_code: "RATE_LIMITED",
  retry_after_seconds: 1,
});

describe("bounded tool failure evidence", () => {
  it("preserves complete error evidence when the turn fits the existing limits", () => {
    const messages = [request(), ...exchange("failed", "slack_read_thread", failure, true)];
    expect(project(messages)).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Read the discussion and explain the result." }],
      },
      {
        type: "function_call",
        call_id: "failed",
        name: "slack_read_thread",
        arguments: '{"thread":"discussion"}',
      },
      {
        type: "function_call_output",
        call_id: "failed",
        output: `[Tool result status: error]\n${failure}`,
      },
    ]);
  });

  it("keeps the actual error and later recovery evidence from a turn over 370 messages", () => {
    const messages = oversizedTurn();
    expect(messages.length).toBeGreaterThan(370);

    expect(project(messages)).toEqual([
      expect.objectContaining({ role: "user" }),
      expect.objectContaining({ type: "function_call", call_id: "failed" }),
      {
        type: "function_call_output",
        call_id: "failed",
        output: `[Tool result status: error]\n${failure}`,
      },
      expect.objectContaining({ type: "function_call", call_id: "recovered" }),
      {
        type: "function_call_output",
        call_id: "recovered",
        output: "Discussion read successfully.",
      },
      expect.objectContaining({
        content: [
          {
            type: "input_text",
            text: expect.stringContaining("Calls without a recorded result have unknown outcomes"),
          },
        ],
      }),
    ]);
  });

  it("retains the complete failed tool result when unrelated output exceeds a field limit", () => {
    const messages = [
      request(),
      ...exchange("large-success", "read", "x".repeat(70_000)),
      ...exchange("failed", "slack_read_thread", failure, true),
    ];
    expect(project(messages)).toEqual([
      expect.objectContaining({ role: "user" }),
      expect.objectContaining({ type: "function_call", call_id: "failed" }),
      {
        type: "function_call_output",
        call_id: "failed",
        output: `[Tool result status: error]\n${failure}`,
      },
      expect.objectContaining({
        content: [{ type: "input_text", text: expect.stringContaining("Other work") }],
      }),
    ]);
  });

  it("keeps ordinary settled recovery subject to the complete current-turn limit", () => {
    expect(() => project(oversizedTurn(), false)).toThrow(new CodexHistoryRejection("item_limit"));
  });

  it("rejects mismatched omitted evidence before selecting the error", () => {
    const messages = oversizedTurn();
    const history = structuredClone(messages);
    const altered = history[350];
    if (altered?.role !== "toolResult") {
      throw new Error("Expected a tool result fixture");
    }
    altered.content = [{ type: "text", text: "changed persisted output" }];
    expect(() =>
      projectVerifiedSettledCodexMessages(history, {
        turnId: "turn-1",
        mirroredMessages: messages,
        settledMessages: messages,
        toolFailureExplanation: true,
      }),
    ).toThrow(new CodexHistoryRejection("provenance_rejected"));
  });

  it("rejects an unpaired call after the replay limit even when the selected failure is valid", () => {
    const messages = oversizedTurn();
    messages.splice(-1, 0, call("missing", "read"));
    expect(() => project(messages)).toThrow(new CodexHistoryRejection("incomplete_pairing"));
  });

  it("retains the per-field limit rather than truncating an oversized actual error", () => {
    const messages = [
      request(),
      ...exchange("failed", "slack_read_thread", "x".repeat(70_000), true),
    ];
    expect(() => project(messages)).toThrow(new CodexHistoryRejection("field_limit"));
  });
});

function project(messages: AgentMessage[], toolFailureExplanation = true) {
  return projectVerifiedSettledCodexMessages(messages, {
    turnId: "turn-1",
    mirroredMessages: messages,
    settledMessages: messages,
    toolFailureExplanation,
  });
}

function oversizedTurn(): AgentMessage[] {
  return [
    request(),
    ...Array.from({ length: 185 }, (_, index) =>
      exchange(`success-${index}`, "read", "Read successfully."),
    ).flat(),
    call("interrupted", "bash"),
    ...exchange("failed", "slack_read_thread", failure, true),
    ...exchange("recovered", "slack_read_thread", "Discussion read successfully."),
    message(
      {
        role: "toolResult",
        toolCallId: "interrupted",
        toolName: "bash",
        isError: true,
        content: [
          {
            type: "text",
            text: "No matching tool result was recorded before the connection ended.",
          },
        ],
        details: { reason: "missing_tool_result" },
      },
      "tool:interrupted:result",
    ),
  ];
}

function exchange(id: string, name: string, text: string, isError = false): AgentMessage[] {
  return [
    call(id, name),
    message(
      {
        role: "toolResult",
        toolCallId: id,
        toolName: name,
        isError,
        content: [{ type: "text", text }],
      },
      `tool:${id}:result`,
    ),
  ];
}

function call(id: string, name: string): AgentMessage {
  return message(
    {
      role: "assistant",
      content: [{ type: "toolCall", id, name, arguments: { thread: "discussion" } }],
    },
    `tool:${id}:call`,
  );
}

function request(): AgentMessage {
  return message(
    { role: "user", content: "Read the discussion and explain the result." },
    "prompt",
  );
}

function message(value: unknown, identity: string): AgentMessage {
  return attachCodexMirrorIdentity(value as AgentMessage, `turn-1:${identity}`);
}
