import { describe, expect, it } from "vitest";
import type { PersistedUserTurnMessage } from "../../../sessions/user-turn-transcript.types.js";
import { createZeroUsageFixture } from "../../test-helpers/usage-fixtures.js";
import type { SessionEntry, SessionMessageEntry } from "../session-manager-types.js";
import { prepareAgentCompactionWork } from "./preparation.js";
import type { AgentCompactionPreparationOptions } from "./preparation.types.js";
import { estimateCompactedRequestTokens } from "./request-budget.js";

function userEntry(
  id: string,
  content: string,
  parentId: string | null = null,
): SessionMessageEntry {
  const message: PersistedUserTurnMessage = {
    role: "user",
    content,
    timestamp: 0,
    idempotencyKey: id,
  };
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00.000Z",
    message,
  };
}

function options() {
  return {
    itemId: "planned-compaction",
    mode: "manual",
    summaryOutputPolicy: "none",
    settings: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 1 },
    requestBudget: {
      contextWindow: 10_000,
      reserveTokens: 1_000,
      fixedTokens: 100,
      pendingTokens: 200,
      pendingUserIdempotencyKey: "pending",
    },
  } satisfies AgentCompactionPreparationOptions;
}

describe("prepareAgentCompactionWork", () => {
  it("preserves admitted pending input and composes its retention and summary budgets", () => {
    const pending = userEntry("pending", "Keep this unprocessed request.", "history");
    const answer: SessionMessageEntry = {
      type: "message",
      id: "answer",
      parentId: pending.id,
      timestamp: "2026-01-01T00:00:01.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Recent context" }],
        api: "openai-responses",
        provider: "openai",
        model: "fixture",
        usage: createZeroUsageFixture(),
        stopReason: "stop",
        timestamp: 1_000,
      },
    };
    const history = userEntry("history", "Earlier completed work.");
    const entries: SessionEntry[] = [history, pending, answer];
    const before = structuredClone(entries);
    const input = { ...options(), requestState: "unresolved" as const };
    const planned = prepareAgentCompactionWork(entries, input);
    expect(planned.status).toBe("prepared");
    if (planned.status !== "prepared" || !planned.requestBudget) {
      throw new Error("Expected budgeted preparation");
    }
    expect(planned.pendingEntryIndex).toBe(1);
    expect(planned.pendingEntryId).toBe(pending.id);
    expect(planned.requestTokenLimit).toBe(9_000);
    expect(planned.contextMessages).toEqual([history.message, pending.message, answer.message]);
    expect(planned.preparation).toMatchObject({
      firstKeptEntryId: pending.id,
      messagesToSummarize: [history.message],
      turnPrefixMessages: [],
      latestUnresolvedUserRequest: "Keep this unprocessed request.",
    });
    const replacement = planned.projectReplacement(planned.preparation, "Checkpoint");
    expect(replacement).toEqual([
      expect.objectContaining({ role: "compactionSummary", summary: "Checkpoint" }),
      pending.message,
      answer.message,
    ]);
    const retainedTokens = estimateCompactedRequestTokens(
      planned.projectReplacement(planned.preparation, ""),
      planned.requestBudget,
    );
    expect(planned.preparation.summaryTokenBudget).toBe(
      Math.floor((9_000 - retainedTokens) / 1.2) - 1,
    );
    expect(
      prepareAgentCompactionWork(entries, { ...input, pendingUserEntryId: pending.id }),
    ).toMatchObject({ pendingEntryId: pending.id, preparation: { firstKeptEntryId: pending.id } });
    expect(() =>
      prepareAgentCompactionWork(entries, { ...input, pendingUserEntryId: "missing-admission" }),
    ).toThrow("find the admitted pending user request");
    expect(() =>
      prepareAgentCompactionWork(entries, {
        ...input,
        requestBudget: { ...input.requestBudget, fixedTokens: 10_001 },
      }),
    ).toThrow("No further history compaction can make this request fit");

    const queued = prepareAgentCompactionWork(entries, {
      ...input,
      requestBudget: { ...planned.requestBudget, pendingUserIdempotencyKey: "not-recorded-yet" },
    });
    expect(queued.status).toBe("prepared");
    if (queued.status !== "prepared") {
      throw new Error("Expected queued-input preparation");
    }
    expect(queued.pendingEntryIndex).toBe(-1);
    expect(queued.preparation.requestSelection).toBeUndefined();
    expect(queued.preparation.latestUnresolvedUserRequest).toBeUndefined();
    expect(entries).toEqual(before);
  });

  it("keeps the SDK manual minimum-tail fallback for budgeted none-policy work", () => {
    const entries = [
      userEntry("history", "Earlier work."),
      userEntry("recent", "Recent work.", "history"),
    ];
    const input = options();
    const requestBudget = { ...input.requestBudget, pendingTokens: 0 };
    const configured = {
      ...input,
      requestBudget,
      settings: { ...input.settings, keepRecentTokens: 10_000 },
    };
    const planned = prepareAgentCompactionWork(entries, configured);
    expect(planned.status).toBe("prepared");
    if (planned.status !== "prepared") {
      throw new Error("Expected manual minimum-tail preparation");
    }
    expect(planned.preparation.firstKeptEntryId).toBe("recent");
    expect(planned.preparation.settings.keepRecentTokens).toBe(0);
    expect(configured.settings.keepRecentTokens).toBe(10_000);
    expect(prepareAgentCompactionWork(entries, { ...configured, mode: "auto" })).toEqual({
      status: "skipped",
      reason: "Nothing to compact (session too small)",
    });
    expect(
      prepareAgentCompactionWork(entries, {
        ...configured,
        summaryOutputPolicy: "retry-invalid-once",
      }),
    ).toEqual({ status: "skipped", reason: "Nothing to compact (session too small)" });
  });
});
