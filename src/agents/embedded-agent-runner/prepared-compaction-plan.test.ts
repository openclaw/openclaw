import { describe, expect, it } from "vitest";
import { getMessageFromEntryForCompaction } from "../../../packages/agent-core/src/harness/compaction/compaction-cut-point.js";
import {
  collectCompactionPreparationEntryFact,
  estimateContextTokens,
} from "../../../packages/agent-core/src/harness/compaction/compaction-preparation.js";
import { prepareCompaction } from "../../../packages/agent-core/src/harness/compaction/compaction.js";
import { collectConversationMessageFact } from "../../../packages/agent-core/src/harness/compaction/utils.js";
import { convertToLlm } from "../../../packages/agent-core/src/harness/messages.js";
import { buildSessionContext } from "../../../packages/agent-core/src/harness/session/session.js";
import type { PreparedCompactionEntry } from "../../config/sessions/session-compaction-prepared.types.js";
import { sanitizeCompactionReplayMessages } from "../compaction-replay.js";
import { estimateCompactionHistoryTokens } from "../sessions/context-token-pressure.js";
import type { SessionEntry } from "../sessions/session-manager-types.js";
import { finalizePreparedCompaction, prepareCompactionPlan } from "./prepared-compaction-plan.js";

describe("prepared compaction worker plan", () => {
  it("matches the baseline cut and final accounting without returning transcript payloads", () => {
    const payload = "private transcript body ".repeat(300);
    const entries: SessionEntry[] = Array.from({ length: 8 }, (_, index) => ({
      type: "message",
      id: "entry-" + index,
      parentId: index ? "entry-" + (index - 1) : null,
      timestamp: new Date(index).toISOString(),
      message: { role: "user", content: payload + index, timestamp: index },
    }));
    const facts: PreparedCompactionEntry[] = entries.map((entry, index) => ({
      ...collectCompactionPreparationEntryFact(entry, index + 1),
      parentId: entry.parentId,
      conversation: convertToLlm([getMessageFromEntryForCompaction(entry)!]).map(
        (message, messageIndex) =>
          collectConversationMessageFact(message, { seq: index + 1, index: messageIndex }),
      ),
    }));
    const settings = { enabled: true, reserveTokens: 0, keepRecentTokens: 1 };
    const result = prepareCompactionPlan(facts, { settings }, (seq) => entries[seq - 1]!);
    const guarded = prepareCompactionPlan(
      facts,
      { settings, safeguard: { recentTurnsPreserve: 0, qualityGuardEnabled: true } },
      (seq) => entries[seq - 1]!,
    );
    expect(guarded.status).toBe("prepared");
    if (guarded.status !== "prepared") {
      throw new Error("Expected safeguard plan");
    }
    expect(guarded.plan.safeguard?.reconciliationCount).toBeGreaterThan(0);
    expect(guarded.plan.selections.history.length).toBe(
      guarded.plan.safeguard?.reconciliationCount,
    );
    expect(guarded.plan.safeguard).not.toHaveProperty("messagesToSummarize");
    const baseline = prepareCompaction(entries, settings);
    expect(baseline.ok).toBe(true);
    if (!baseline.ok || !baseline.value || result.status !== "prepared") {
      throw new Error("Expected compaction");
    }
    expect(result.plan.preparation.firstKeptEntryId).toBe(baseline.value.firstKeptEntryId);
    expect(result.plan.preparation.tokensBefore).toBe(baseline.value.tokensBefore);
    expect(JSON.stringify(result)).not.toContain(payload);
    const summary = {
      summary: "A bounded summary",
      firstKeptEntryId: baseline.value.firstKeptEntryId,
      tokensBefore: baseline.value.tokensBefore,
    };
    const retained = result.plan.retainedSequences.map((seq) => entries[seq - 1]!);
    const finalized = finalizePreparedCompaction(retained, summary, { itemId: "compact" });
    const expected = sanitizeCompactionReplayMessages(
      buildSessionContext([
        ...entries,
        {
          ...summary,
          type: "compaction",
          id: "compact",
          parentId: entries.at(-1)!.id,
          timestamp: new Date().toISOString(),
        },
      ]).messages,
    );
    expect(finalized).toEqual({
      tokensAfter: estimateContextTokens(expected).tokens,
      reportingTokensAfter: estimateCompactionHistoryTokens(expected),
      messageCountAfter: expected.length,
    });
    expect(() =>
      finalizePreparedCompaction(retained, summary, {
        itemId: "compact",
        pendingEntryId: "missing",
      }),
    ).toThrow("unprocessed pending");
    expect(() =>
      finalizePreparedCompaction(retained, summary, {
        itemId: "compact",
        requestBudget: { contextWindow: 100, reserveTokens: 0, fixedTokens: 1, pendingTokens: 1 },
        requestTokenLimit: 1,
      }),
    ).toThrow("exceeds the foreground");
  });
});
