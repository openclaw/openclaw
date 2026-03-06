import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
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

  it("restores pending tool calls from disk across session-manager reopen", () => {
    const root = mkdtempSync(join(tmpdir(), "oc-pending-"));
    const sessionFile = join(root, "session.jsonl");

    const sm1 = SessionManager.open(sessionFile);
    installSessionToolResultGuard(sm1, { pendingToolResultGraceMs: 30_000 });

    sm1.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_disk_1", name: "read", arguments: {} }],
      }),
    );

    const pendingFile = `${sessionFile}.pending-tool-calls.json`;
    expect(existsSync(pendingFile)).toBe(true);

    const sm2 = SessionManager.open(sessionFile);
    const guard2 = installSessionToolResultGuard(sm2, { pendingToolResultGraceMs: 30_000 });

    expect(guard2.getPendingIds()).toContain("call_disk_1");
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
      .map((e) => (e as unknown as { message: AgentMessage }).message);

    expect(messages.map((m) => m.role)).toEqual(["assistant", "toolResult", "assistant"]);
    const synthetic = messages[1] as Extract<AgentMessage, { role: "toolResult" }>;
    expect(synthetic.toolCallId).toBe("call_1");
    expect(synthetic.isError).toBe(true);
    vi.useRealTimers();
  });
});
