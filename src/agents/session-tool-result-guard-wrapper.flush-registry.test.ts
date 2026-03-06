import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  flushAllActiveSessionGuards,
  guardSessionManager,
} from "./session-tool-result-guard-wrapper.js";

function assistantToolCall(id: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name: "n", arguments: {} }],
  } as AgentMessage;
}

function getMessages(sm: SessionManager): AgentMessage[] {
  return sm
    .getEntries()
    .filter((e) => e.type === "message")
    .map((e) => (e as { message: AgentMessage }).message);
}

describe("flushAllActiveSessionGuards", () => {
  afterEach(() => {
    // Clean up any remaining registry state between tests.
    flushAllActiveSessionGuards();
  });

  it("flushes pending tool results for all active guarded sessions on gateway restart", () => {
    // Simulate two in-flight sessions with open tool calls (e.g. gateway restart mid-turn).
    const sm1 = guardSessionManager(SessionManager.inMemory());
    const sm2 = guardSessionManager(SessionManager.inMemory());
    const append1 = sm1.appendMessage.bind(sm1) as unknown as (msg: AgentMessage) => void;
    const append2 = sm2.appendMessage.bind(sm2) as unknown as (msg: AgentMessage) => void;

    // Each session has an outstanding tool call with no matching result yet.
    append1(assistantToolCall("call_a"));
    append2(assistantToolCall("call_b"));

    // Before flush: no synthetic tool results.
    expect(getMessages(sm1).map((m) => m.role)).toEqual(["assistant"]);
    expect(getMessages(sm2).map((m) => m.role)).toEqual(["assistant"]);

    // Simulate gateway restart — flush all pending tool results globally.
    flushAllActiveSessionGuards();

    // After flush: each session gets a synthetic toolResult closing the orphaned call.
    const msgs1 = getMessages(sm1);
    const msgs2 = getMessages(sm2);
    expect(msgs1.map((m) => m.role)).toEqual(["assistant", "toolResult"]);
    expect(msgs2.map((m) => m.role)).toEqual(["assistant", "toolResult"]);
    expect((msgs1[1] as { toolCallId?: string }).toolCallId).toBe("call_a");
    expect((msgs2[1] as { toolCallId?: string }).toolCallId).toBe("call_b");
  });

  it("deregisters from global registry when session flushPendingToolResults is called directly", () => {
    const sm = guardSessionManager(SessionManager.inMemory());
    const append = sm.appendMessage.bind(sm) as unknown as (msg: AgentMessage) => void;
    append(assistantToolCall("call_c"));

    // Normal teardown path: flush via the session manager directly.
    sm.flushPendingToolResults?.();

    // Verify synthetic result was written.
    const msgs = getMessages(sm);
    expect(msgs.map((m) => m.role)).toEqual(["assistant", "toolResult"]);
    expect((msgs[1] as { toolCallId?: string }).toolCallId).toBe("call_c");

    // Subsequent global flush must not double-flush or throw.
    expect(() => flushAllActiveSessionGuards()).not.toThrow();

    // No additional messages appended by second flush.
    expect(getMessages(sm).map((m) => m.role)).toEqual(["assistant", "toolResult"]);
  });

  it("is a no-op when no sessions are active", () => {
    expect(() => flushAllActiveSessionGuards()).not.toThrow();
  });
});
