import { describe, expect, it, vi } from "vitest";
import {
  emptySqliteCounts,
  observeParentSqlite,
} from "../../../../test/helpers/sqlite-parent-observer.js";
import { replaceSessionEntrySync } from "../../../config/sessions/session-accessor.sqlite-entry.js";
import { closeOpenClawAgentDatabasesAsync } from "../../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import {
  loadAttemptSessionEntryAfterQuotaMaintenance,
  removeTrailingMidTurnPrecheckAssistantError,
} from "./attempt-transcript-helpers.js";
import { MidTurnPrecheckSignal } from "./midturn-precheck.js";

it("reads an unsuspended attempt session without main-thread SQLite work", async () => {
  await withOpenClawTestState({ label: "attempt-quota-read" }, async (state) => {
    const target = {
      agentId: "main",
      sessionKey: "agent:main:quota-read",
      storePath: state.sessionsDir() + "/sessions.json",
    };
    replaceSessionEntrySync(target, { sessionId: "quota-read", updatedAt: 1 });
    await closeOpenClawAgentDatabasesAsync();
    const observer = observeParentSqlite();
    try {
      expect(await loadAttemptSessionEntryAfterQuotaMaintenance(target, () => {})).toMatchObject({
        sessionId: "quota-read",
      });
      expect(observer.counts).toEqual(emptySqliteCounts());
    } finally {
      observer.restore();
    }
  });
});

describe("attempt transcript cleanup", () => {
  it("keeps live messages unchanged when the durable suffix fence rejects cleanup", () => {
    const user = { role: "user", content: "question" };
    const signal = new MidTurnPrecheckSignal({
      route: "compact_only",
      estimatedPromptTokens: 1,
      promptBudgetBeforeReserve: 1,
      overflowTokens: 1,
      toolResultReducibleChars: 0,
      effectiveReserveTokens: 0,
    });
    const precheckError = {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: signal.message,
    };
    const messages = [user, precheckError];
    const fenceError = new Error("concurrent transcript append");
    const removeTrailingEntries = vi.fn(() => {
      throw fenceError;
    });
    const activeSession = { agent: { state: { messages } } };
    const getEntries = vi.fn(() => [{ type: "message", message: precheckError }]);

    expect(() =>
      removeTrailingMidTurnPrecheckAssistantError({
        activeSession: activeSession as never,
        sessionManager: { getEntries, removeTrailingEntries } as never,
      }),
    ).toThrow(fenceError);

    expect(activeSession.agent.state.messages).toBe(messages);
    expect(activeSession.agent.state.messages).toEqual([user, precheckError]);
  });
});
