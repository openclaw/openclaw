import { SessionManager } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { installSessionToolResultGuard } from "./session-tool-result-guard.js";

type AppendMessage = Parameters<SessionManager["appendMessage"]>[0];
const asAppendMessage = (message: unknown) => message as AppendMessage;

describe("session tool-result guard TTL behavior", () => {
  it("does not insert synthetic toolResult before TTL on non-tool message", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm, { pendingToolResultGraceMs: 30_000 });

    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
      }),
    );

    sm.appendMessage(
      asAppendMessage({ role: "assistant", content: [{ type: "text", text: "intermediate" }] }),
    );

    const roles = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: { role: string } }).message.role);

    expect(roles).toEqual(["assistant", "assistant"]);
  });

  it("inserts synthetic toolResult after TTL expires", () => {
    vi.useFakeTimers();
    const now = new Date("2026-03-05T10:00:00.000Z");
    vi.setSystemTime(now);

    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm, { pendingToolResultGraceMs: 30_000 });

    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
      }),
    );

    vi.advanceTimersByTime(31_000);

    sm.appendMessage(
      asAppendMessage({ role: "assistant", content: [{ type: "text", text: "after timeout" }] }),
    );

    const messages = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: Record<string, unknown> }).message);

    expect(messages.map((m) => m.role)).toEqual(["assistant", "toolResult", "assistant"]);
    expect(messages[1].toolCallId).toBe("call_1");
    expect(messages[1].isError).toBe(true);
    vi.useRealTimers();
  });
});
