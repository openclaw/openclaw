import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { installSessionToolResultGuard } from "./session-tool-result-guard.js";

const toolCallMessage = {
  role: "assistant",
  content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
} satisfies AgentMessage;

describe("installSessionToolResultGuard", () => {
  it("inserts synthetic toolResult before non-tool message when pending", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm);

    sm.appendMessage(toolCallMessage);
    sm.appendMessage({
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

  it("flushes pending tool calls when asked explicitly", () => {
    const sm = SessionManager.inMemory();
    const guard = installSessionToolResultGuard(sm);

    sm.appendMessage(toolCallMessage);
    guard.flushPendingToolResults();

    const messages = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: AgentMessage }).message);

    expect(messages.map((m) => m.role)).toEqual(["assistant", "toolResult"]);
  });

  it("does not add synthetic toolResult when a matching one exists", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm);

    sm.appendMessage(toolCallMessage);
    sm.appendMessage({
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

  it("preserves ordering with multiple tool calls and partial results", () => {
    const sm = SessionManager.inMemory();
    const guard = installSessionToolResultGuard(sm);

    sm.appendMessage({
      role: "assistant",
      content: [
        { type: "toolCall", id: "call_a", name: "one", arguments: {} },
        { type: "toolUse", id: "call_b", name: "two", arguments: {} },
      ],
    } as AgentMessage);
    sm.appendMessage({
      role: "toolResult",
      toolUseId: "call_a",
      content: [{ type: "text", text: "a" }],
      isError: false,
    } as AgentMessage);
    sm.appendMessage({
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

  it("flushes pending on guard when no toolResult arrived", () => {
    const sm = SessionManager.inMemory();
    const guard = installSessionToolResultGuard(sm);

    sm.appendMessage(toolCallMessage);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "hard error" }],
      stopReason: "error",
    } as AgentMessage);
    expect(guard.getPendingIds()).toEqual([]);
  });

  it("handles toolUseId on toolResult", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm);

    sm.appendMessage({
      role: "assistant",
      content: [{ type: "toolUse", id: "use_1", name: "f", arguments: {} }],
    } as AgentMessage);
    sm.appendMessage({
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

  it("parallel tool results all have assistant message as parent (not each other)", () => {
    // This test verifies the fix for the bug where multiple tool results from
    // the same assistant message were getting chained parentIds instead of all
    // pointing to the assistant message. This caused Anthropic API 400 errors:
    // "tool_use ids were found without tool_result blocks immediately after"
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm);

    // Assistant message with 3 parallel tool calls
    sm.appendMessage({
      role: "assistant",
      content: [
        { type: "toolCall", id: "call_1", name: "read", arguments: {} },
        { type: "toolCall", id: "call_2", name: "write", arguments: {} },
        { type: "toolCall", id: "call_3", name: "exec", arguments: {} },
      ],
    } as AgentMessage);

    // Get the assistant message entry ID
    const entries = sm.getEntries();
    const assistantEntry = entries.find(
      (e) => e.type === "message" && (e as { message: AgentMessage }).message.role === "assistant",
    );
    expect(assistantEntry).toBeDefined();
    const assistantId = assistantEntry!.id;

    // Append all three tool results
    sm.appendMessage({
      role: "toolResult",
      toolCallId: "call_1",
      content: [{ type: "text", text: "result 1" }],
      isError: false,
    } as AgentMessage);
    sm.appendMessage({
      role: "toolResult",
      toolCallId: "call_2",
      content: [{ type: "text", text: "result 2" }],
      isError: false,
    } as AgentMessage);
    sm.appendMessage({
      role: "toolResult",
      toolCallId: "call_3",
      content: [{ type: "text", text: "result 3" }],
      isError: false,
    } as AgentMessage);

    // Verify all entries
    const allEntries = sm.getEntries();
    const toolResultEntries = allEntries.filter(
      (e) => e.type === "message" && (e as { message: AgentMessage }).message.role === "toolResult",
    );

    expect(toolResultEntries).toHaveLength(3);

    // THE FIX: All tool result entries should have the assistant message as their parent
    // Before the fix, they would be chained: assistant -> result1 -> result2 -> result3
    // After the fix, they should all point to assistant: assistant -> result1, result2, result3
    for (const entry of toolResultEntries) {
      expect(entry.parentId).toBe(assistantId);
    }
  });

  it("parallel synthetic tool results all have assistant message as parent", () => {
    // Same test but for synthetic tool results generated when flush is called
    const sm = SessionManager.inMemory();
    const guard = installSessionToolResultGuard(sm);

    // Assistant message with 2 parallel tool calls
    sm.appendMessage({
      role: "assistant",
      content: [
        { type: "toolCall", id: "call_a", name: "read", arguments: {} },
        { type: "toolCall", id: "call_b", name: "write", arguments: {} },
      ],
    } as AgentMessage);

    // Get the assistant message entry ID before flushing
    const entriesBefore = sm.getEntries();
    const assistantEntry = entriesBefore.find(
      (e) => e.type === "message" && (e as { message: AgentMessage }).message.role === "assistant",
    );
    expect(assistantEntry).toBeDefined();
    const assistantId = assistantEntry!.id;

    // Flush to generate synthetic tool results
    guard.flushPendingToolResults();

    // Verify synthetic tool results
    const allEntries = sm.getEntries();
    const toolResultEntries = allEntries.filter(
      (e) => e.type === "message" && (e as { message: AgentMessage }).message.role === "toolResult",
    );

    expect(toolResultEntries).toHaveLength(2);

    // Both synthetic results should have assistant as parent
    for (const entry of toolResultEntries) {
      expect(entry.parentId).toBe(assistantId);
    }
  });
});
