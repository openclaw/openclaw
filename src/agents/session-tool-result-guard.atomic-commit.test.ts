/**
 * Tests for pair-atomic tool_use/tool_result commit behavior.
 *
 * Verifies that orphaned tool_use blocks are never written to JSONL when
 * a run is interrupted (abort / failover / rate-limit). The pair buffer
 * must be discarded atomically on any interruption, leaving no corrupt state.
 */
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installSessionToolResultGuard } from "./session-tool-result-guard.js";

type AppendMessage = Parameters<SessionManager["appendMessage"]>[0];

const asMsg = (message: unknown) => message as AppendMessage;

function makeToolCallMsg(id: string, name = "read") {
  return asMsg({
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: {} }],
  });
}

function makeToolResultMsg(callId: string, name = "read", text = "ok") {
  return asMsg({
    role: "toolResult",
    toolCallId: callId,
    toolName: name,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: Date.now(),
  });
}

function makeUserMsg(text: string) {
  return asMsg({
    role: "user",
    content: [{ type: "text", text }],
  });
}

function getPersistedMessages(sm: SessionManager): AgentMessage[] {
  return sm
    .getEntries()
    .filter((e) => e.type === "message")
    .map((e) => (e as { message: AgentMessage }).message);
}

function getPersistedRoles(sm: SessionManager): string[] {
  return getPersistedMessages(sm).map((m) => String((m as { role?: unknown }).role));
}

function hasOrphanToolUse(messages: AgentMessage[]): boolean {
  const resultIds = new Set<string>();
  for (const msg of messages) {
    const role = (msg as { role?: unknown }).role;
    if (role === "toolResult") {
      const id = (msg as { toolCallId?: string }).toolCallId;
      if (id) {
        resultIds.add(id);
      }
    }
  }
  for (const msg of messages) {
    const role = (msg as { role?: unknown }).role;
    if (role !== "assistant") {
      continue;
    }
    const content = (msg as { content?: unknown[] }).content ?? [];
    for (const block of content) {
      const type = (block as { type?: string }).type;
      if (type === "toolCall" || type === "toolUse" || type === "functionCall") {
        const id = (block as { id?: string }).id;
        if (id && !resultIds.has(id)) {
          return true;
        }
      }
    }
  }
  return false;
}

describe("pair-atomic tool_use/tool_result commit (discard mode)", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    // Ensure default discard mode for all tests
    originalEnv = process.env.OPENCLAW_TOOL_GUARD_ABORT_MODE;
    delete process.env.OPENCLAW_TOOL_GUARD_ABORT_MODE;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.OPENCLAW_TOOL_GUARD_ABORT_MODE;
    } else {
      process.env.OPENCLAW_TOOL_GUARD_ABORT_MODE = originalEnv;
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Case 1: abort during tool execution
  // ─────────────────────────────────────────────────────────────────────────
  it("Case1: abort during tool execution leaves no orphan tool_use in JSONL", () => {
    const sm = SessionManager.inMemory();
    const guard = installSessionToolResultGuard(sm);

    // Append assistant with tool_use — pair buffer should be in flight
    sm.appendMessage(makeToolCallMsg("call_abort_1"));

    // Simulate abort before tool_result arrives
    guard.flushPendingToolResults("abort");

    const messages = getPersistedMessages(sm);
    // Nothing should have been written — incomplete pair was discarded
    expect(messages).toHaveLength(0);
    expect(hasOrphanToolUse(messages)).toBe(false);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Case 2: failover during tool execution
  // ─────────────────────────────────────────────────────────────────────────
  it("Case2: failover during tool execution leaves no orphan tool_use in JSONL", () => {
    const sm = SessionManager.inMemory();
    const guard = installSessionToolResultGuard(sm);

    sm.appendMessage(makeToolCallMsg("call_failover_1"));

    // Simulate provider failover
    guard.flushPendingToolResults("failover");

    const messages = getPersistedMessages(sm);
    expect(messages).toHaveLength(0);
    expect(hasOrphanToolUse(messages)).toBe(false);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Case 3: rate-limit interruption leaves JSONL unchanged
  // ─────────────────────────────────────────────────────────────────────────
  it("Case3: rate-limit interruption leaves JSONL unchanged (user message preserved)", () => {
    const sm = SessionManager.inMemory();
    const guard = installSessionToolResultGuard(sm);

    // Pre-existing user message that must not be touched
    sm.appendMessage(makeUserMsg("hello"));

    // Assistant starts a tool call — enters pair buffer
    sm.appendMessage(makeToolCallMsg("call_ratelimit_1"));

    // Simulate rate-limit abort before tool_result
    guard.flushPendingToolResults("rate_limit");

    const messages = getPersistedMessages(sm);
    // Only the user message should remain; tool_use was discarded
    const roles = messages.map((m) => String((m as { role?: unknown }).role));
    expect(roles).toEqual(["user"]);
    expect(hasOrphanToolUse(messages)).toBe(false);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Case 4: normal tool_use/result pair committed correctly
  // ─────────────────────────────────────────────────────────────────────────
  it("Case4: normal tool_use/result pair is committed to JSONL in order", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm);

    sm.appendMessage(makeToolCallMsg("call_normal_1"));
    sm.appendMessage(makeToolResultMsg("call_normal_1"));

    const roles = getPersistedRoles(sm);
    // Pair should be committed: assistant first, then toolResult
    expect(roles).toEqual(["assistant", "toolResult"]);
    expect(hasOrphanToolUse(getPersistedMessages(sm))).toBe(false);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Case 5: two sequential tool calls — first completes, second aborted
  //   use1 → result1 → use2 → abort
  //   Expected JSONL: [assistant(use1), toolResult(result1)]
  //   use2 must NOT appear
  // ─────────────────────────────────────────────────────────────────────────
  it(
    "Case5: first pair committed, second pair aborted — " +
      "use1/result1 remain, use2 discarded, no orphan",
    () => {
      const sm = SessionManager.inMemory();
      const guard = installSessionToolResultGuard(sm);

      // First tool call — pair 1
      sm.appendMessage(makeToolCallMsg("call_seq_1"));
      // Matching result for pair 1 → triggers commit
      sm.appendMessage(makeToolResultMsg("call_seq_1"));

      // Second tool call — pair 2 starts (not yet committed)
      sm.appendMessage(makeToolCallMsg("call_seq_2"));

      // Abort before result2 arrives
      guard.flushPendingToolResults("abort");

      const messages = getPersistedMessages(sm);
      const roles = messages.map((m) => String((m as { role?: unknown }).role));

      // Pair 1 must be in JSONL
      expect(roles).toContain("assistant");
      expect(roles).toContain("toolResult");

      // Pair 2 must NOT be in JSONL
      const allToolUseIds = messages.flatMap((msg) => {
        if ((msg as { role?: unknown }).role !== "assistant") {
          return [];
        }
        const content = (msg as { content?: unknown[] }).content ?? [];
        return content
          .filter((b) => {
            const t = (b as { type?: string }).type;
            return t === "toolCall" || t === "toolUse" || t === "functionCall";
          })
          .map((b) => (b as { id?: string }).id ?? "");
      });
      expect(allToolUseIds).not.toContain("call_seq_2");

      // Overall: no orphan tool_use blocks
      expect(hasOrphanToolUse(messages)).toBe(false);

      // Exactly: [assistant(use1), toolResult(result1)]
      expect(roles).toEqual(["assistant", "toolResult"]);
    },
  );
});
