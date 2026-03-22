import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { installSessionToolResultGuard } from "./session-tool-result-guard.js";

const toolCallMessage = {
  role: "assistant",
  content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
} satisfies AgentMessage;

describe("installSessionToolResultGuard", () => {
  it("inserts synthetic toolResult before non-tool message when pending", async () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm);

    await sm.appendMessage(toolCallMessage);
    await sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "error" }],
      stopReason: "error",
    } as AgentMessage);

    const entries = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: AgentMessage }).message);

    expect(entries.map((m) => m.role)).toEqual(["assistant", "toolResult", "assistant"]);
    const synthetic = entries[1] as {
      toolCallId?: string;
      isError?: boolean;
      content?: Array<{ type?: string; text?: string }>;
    };
    expect(synthetic.toolCallId).toBe("call_1");
    expect(synthetic.isError).toBe(true);
    expect(synthetic.content?.[0]?.text).toContain("missing tool result");
  });

  it("flushes pending tool calls when asked explicitly", async () => {
    const sm = SessionManager.inMemory();
    const guard = installSessionToolResultGuard(sm);

    await sm.appendMessage(toolCallMessage);
    guard.flushPendingToolResults();

    const messages = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: AgentMessage }).message);

    expect(messages.map((m) => m.role)).toEqual(["assistant", "toolResult"]);
  });

  it("does not add synthetic toolResult when a matching one exists", async () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm);

    await sm.appendMessage(toolCallMessage);
    await sm.appendMessage({
      role: "toolResult",
      toolCallId: "call_1",
      content: [{ type: "text", text: "ok" }],
      isError: false,
    } as AgentMessage);

    const messages = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: AgentMessage }).message);

    expect(messages.map((m) => m.role)).toEqual(["assistant", "toolResult"]);
  });

  it("preserves ordering with multiple tool calls and partial results", async () => {
    const sm = SessionManager.inMemory();
    const guard = installSessionToolResultGuard(sm);

    await sm.appendMessage({
      role: "assistant",
      content: [
        { type: "toolCall", id: "call_a", name: "one", arguments: {} },
        { type: "toolUse", id: "call_b", name: "two", arguments: {} },
      ],
    } as AgentMessage);
    await sm.appendMessage({
      role: "toolResult",
      toolUseId: "call_a",
      content: [{ type: "text", text: "a" }],
      isError: false,
    } as AgentMessage);
    await sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "after tools" }],
    } as AgentMessage);

    const messages = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: AgentMessage }).message);

    expect(messages.map((m) => m.role)).toEqual([
      "assistant", // tool calls
      "toolResult", // call_a real
      "toolResult", // synthetic for call_b
      "assistant", // text
    ]);
    expect((messages[2] as { toolCallId?: string }).toolCallId).toBe("call_b");
    expect(guard.getPendingIds()).toEqual([]);
  });

  it("flushes pending on guard when no toolResult arrived", async () => {
    const sm = SessionManager.inMemory();
    const guard = installSessionToolResultGuard(sm);

    await sm.appendMessage(toolCallMessage);
    await sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "hard error" }],
      stopReason: "error",
    } as AgentMessage);
    expect(guard.getPendingIds()).toEqual([]);
  });

  it("handles toolUseId on toolResult", async () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm);

    await sm.appendMessage({
      role: "assistant",
      content: [{ type: "toolUse", id: "use_1", name: "f", arguments: {} }],
    } as AgentMessage);
    await sm.appendMessage({
      role: "toolResult",
      toolUseId: "use_1",
      content: [{ type: "text", text: "ok" }],
    } as AgentMessage);

    const messages = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: AgentMessage }).message);
    expect(messages.map((m) => m.role)).toEqual(["assistant", "toolResult"]);
  });
});

describe("concurrent append race condition", () => {
  it("does not synthesize when toolResult arrives concurrently with next assistant message", async () => {
    // Simulate the exact race: tool_calls appended, then toolResult and a
    // completion message are dispatched concurrently (both microtasks queued).
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm);

    sm.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "race_1", name: "read", arguments: {} }],
    } as AgentMessage);

    // Fire both concurrently — do NOT await between them
    const p1 = Promise.resolve().then(() =>
      sm.appendMessage({
        role: "toolResult",
        toolCallId: "race_1",
        content: [{ type: "text", text: "real result" }],
        isError: false,
      } as AgentMessage),
    );
    const p2 = Promise.resolve().then(() =>
      sm.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "completion" }],
        stopReason: "endTurn",
      } as AgentMessage),
    );

    await Promise.all([p1, p2]);

    const messages = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: AgentMessage }).message);

    // Must be exactly 3 messages: tool_calls, real toolResult, completion
    expect(messages.map((m) => m.role)).toEqual(["assistant", "toolResult", "assistant"]);
    // The toolResult must be the real one, not synthetic
    const tr = messages[1] as { isError?: boolean; content?: Array<{ text?: string }> };
    expect(tr.isError).toBe(false);
    expect(tr.content?.[0]?.text).toBe("real result");
  });

  it("serializes multiple concurrent appends without duplicating messages", async () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm);

    sm.appendMessage({
      role: "assistant",
      content: [
        { type: "toolCall", id: "c1", name: "a", arguments: {} },
        { type: "toolCall", id: "c2", name: "b", arguments: {} },
      ],
    } as AgentMessage);

    // Fire all three results concurrently
    await Promise.all([
      Promise.resolve().then(() =>
        sm.appendMessage({
          role: "toolResult",
          toolCallId: "c1",
          content: [{ type: "text", text: "r1" }],
          isError: false,
        } as AgentMessage),
      ),
      Promise.resolve().then(() =>
        sm.appendMessage({
          role: "toolResult",
          toolCallId: "c2",
          content: [{ type: "text", text: "r2" }],
          isError: false,
        } as AgentMessage),
      ),
    ]);

    const messages = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: AgentMessage }).message);

    // Exactly 3: assistant + 2 real results, no synthetics
    expect(messages.map((m) => m.role)).toEqual(["assistant", "toolResult", "toolResult"]);
    const results = messages.slice(1) as Array<{ isError?: boolean }>;
    expect(results.every((r) => r.isError === false)).toBe(true);
  });

  it("getPendingIds() returns empty after concurrent resolution", async () => {
    const sm = SessionManager.inMemory();
    const guard = installSessionToolResultGuard(sm);

    sm.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "drain_1", name: "x", arguments: {} }],
    } as AgentMessage);

    await Promise.resolve().then(() =>
      sm.appendMessage({
        role: "toolResult",
        toolCallId: "drain_1",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      } as AgentMessage),
    );

    expect(guard.getPendingIds()).toEqual([]);
  });
});
