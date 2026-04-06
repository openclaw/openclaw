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
  it("persists synthetic toolResult before subsequent assistant message", () => {
    const sm = guardSessionManager(SessionManager.inMemory());
    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;

    appendMessage(assistantToolCall("call_1"));
    appendMessage({
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

  it("suppresses only the next persisted user message when requested", () => {
    const sm = guardSessionManager(SessionManager.inMemory(), {
      suppressNextUserMessagePersistence: true,
    });
    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;

    appendMessage({
      role: "user",
      content: "retry prompt",
      timestamp: Date.now(),
    } as AgentMessage);
    appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "retry answer" }],
      timestamp: Date.now(),
    } as AgentMessage);
    appendMessage({
      role: "user",
      content: "follow up",
      timestamp: Date.now(),
    } as AgentMessage);

    const messages = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: AgentMessage }).message);

    expect(messages.map((m) => m.role)).toEqual(["assistant", "user"]);
    expect(messages[1]).toMatchObject({ role: "user", content: "follow up" });
  });
});
