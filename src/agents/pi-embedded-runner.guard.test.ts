import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { guardSessionManager } from "./session-tool-result-guard-wrapper.js";
import { sanitizeToolUseResultPairing } from "./session-transcript-repair.js";

function assistantToolCall(id: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name: "n", arguments: {} }],
  } as AgentMessage;
}

describe("guardSessionManager integration", () => {
  it("handles nested XML-like tags in tool call arguments", () => {
    const sm = guardSessionManager(SessionManager.inMemory());

    sm.appendMessage({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call_nested",
          name: "execute",
          arguments: { code: "<script><inner>payload</inner></script>" },
        },
      ],
    } as AgentMessage);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "done" }],
    } as AgentMessage);

    const messages = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: AgentMessage }).message);

    expect(messages.map((m) => m.role)).toEqual(["assistant", "toolResult", "assistant"]);
  });

  it("handles empty response after tool call", () => {
    const sm = guardSessionManager(SessionManager.inMemory());

    sm.appendMessage(assistantToolCall("call_empty"));
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "" }],
    } as AgentMessage);

    const messages = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: AgentMessage }).message);

    expect(messages.map((m) => m.role)).toEqual(["assistant", "toolResult", "assistant"]);
  });

  it("handles multiple sequential tool calls", () => {
    const sm = guardSessionManager(SessionManager.inMemory());

    sm.appendMessage(assistantToolCall("call_a"));
    sm.appendMessage(assistantToolCall("call_b"));
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "final" }],
    } as AgentMessage);

    const messages = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: AgentMessage }).message);

    const roles = messages.map((m) => m.role);
    expect(roles).toContain("toolResult");
  });

  it("idempotent guard application", () => {
    const sm = guardSessionManager(SessionManager.inMemory());
    const sm2 = guardSessionManager(sm);
    expect(sm).toBe(sm2);
  });

  it("persists synthetic toolResult before subsequent assistant message", () => {
    const sm = guardSessionManager(SessionManager.inMemory());

    sm.appendMessage(assistantToolCall("call_1"));
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "followup" }],
    } as AgentMessage);

    const messages = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: AgentMessage }).message);

    expect(messages.map((m) => m.role)).toEqual(["assistant", "toolResult", "assistant"]);
    expect((messages[1] as { toolCallId?: string }).toolCallId).toBe("call_1");
    expect(sanitizeToolUseResultPairing(messages).map((m) => m.role)).toEqual([
      "assistant",
      "toolResult",
      "assistant",
    ]);
  });
});
