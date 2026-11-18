import { describe, expect, it } from "vitest";
import { getMessageFromEntryForCompaction } from "../../../../packages/agent-core/src/harness/compaction/compaction-cut-point.js";
import { collectCompactionPreparationEntryFact } from "../../../../packages/agent-core/src/harness/compaction/compaction-preparation.js";
import { MAX_COMPACTION_SUMMARY_CHARS } from "../../../../packages/agent-core/src/harness/compaction/compaction.js";
import { projectSessionContextMessage } from "../../../../packages/agent-core/src/harness/session/session.js";
import type { PersistedUserTurnMessage } from "../../../sessions/user-turn-transcript.types.js";
import { createZeroUsageFixture } from "../../test-helpers/usage-fixtures.js";
import {
  collectMessageTokenPressureFact,
  createFixedRequestTokenEstimator,
} from "../context-token-pressure.js";
import type { SessionEntry, SessionMessageEntry } from "../session-manager-types.js";
import {
  createCompactionReplacementProjector,
  prepareAgentCompactionWork,
  prepareAgentCompactionWorkFromFacts,
} from "./preparation.js";
import type {
  AgentCompactionPreparationOptions,
  AgentCompactionPreparationEntryFact,
} from "./preparation.types.js";
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

function prepareWithFactParity(entries: SessionEntry[], input: AgentCompactionPreparationOptions) {
  const facts = entries.map((entry, index): AgentCompactionPreparationEntryFact => {
    const fact = collectCompactionPreparationEntryFact(entry, index);
    const message = getMessageFromEntryForCompaction(entry);
    const pressure = (context: "current" | "retained" | "reset-retained") => {
      const projected = projectSessionContextMessage({
        entry,
        context,
        placement: fact.pendingBackground ? entry : undefined,
      });
      return projected ? collectMessageTokenPressureFact(projected) : undefined;
    };
    return {
      ...fact,
      idempotencyKey:
        entry.type === "message" &&
        "idempotencyKey" in entry.message &&
        typeof entry.message.idempotencyKey === "string"
          ? entry.message.idempotencyKey
          : undefined,
      tokenPressure: {
        message: message ? collectMessageTokenPressureFact(message) : undefined,
        current: pressure("current"),
        retained: pressure("retained"),
        "reset-retained": pressure("reset-retained"),
      },
    };
  });
  const { systemPrompt, tools, ...scalarInput } = input;
  let replacementCalls = 0;
  const fromFacts = () =>
    prepareAgentCompactionWorkFromFacts(
      facts,
      {
        ...scalarInput,
        fixedTokenPressure: createFixedRequestTokenEstimator()({ systemPrompt, tools }),
      },
      (preparation, budget) => {
        replacementCalls += 1;
        return estimateCompactedRequestTokens(
          createCompactionReplacementProjector(entries, input.itemId)(preparation, ""),
          budget,
        );
      },
    );
  let expected: ReturnType<typeof prepareAgentCompactionWork>;
  try {
    expected = prepareAgentCompactionWork(entries, input);
  } catch (error) {
    expect(fromFacts).toThrow(error instanceof Error ? error.message : String(error));
    expect(replacementCalls).toBe(0);
    throw error;
  }
  const actual = fromFacts();
  expect(replacementCalls).toBe(expected.status === "prepared" && expected.requestBudget ? 1 : 0);
  if (expected.status === "prepared" && actual.status === "prepared") {
    const {
      contextMessages: _context,
      projectReplacement: _project,
      preparation,
      ...metadata
    } = expected;
    const { messagesToSummarize, turnPrefixMessages, ...details } = preparation;
    const { historyEntryIndexes, turnPrefixEntryIndexes, ...actualDetails } = actual.preparation;
    expect(actual).toEqual({ ...metadata, preparation: actual.preparation });
    expect(actualDetails).toEqual({
      ...details,
      firstKeptEntryIndex: entries.findIndex((entry) => entry.id === preparation.firstKeptEntryId),
    });
    const project = (index: number) => getMessageFromEntryForCompaction(entries[index]!);
    expect(historyEntryIndexes.map(project)).toEqual(messagesToSummarize);
    expect(turnPrefixEntryIndexes.map(project)).toEqual(turnPrefixMessages);
  } else {
    expect(actual).toEqual(expected);
  }
  return expected;
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
    const planned = prepareWithFactParity(entries, input);
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
      prepareWithFactParity(entries, { ...input, pendingUserEntryId: pending.id }),
    ).toMatchObject({ pendingEntryId: pending.id, preparation: { firstKeptEntryId: pending.id } });
    expect(() =>
      prepareWithFactParity(entries, { ...input, pendingUserEntryId: "missing-admission" }),
    ).toThrow("find the admitted pending user request");
    expect(() =>
      prepareWithFactParity(entries, {
        ...input,
        requestBudget: { ...input.requestBudget, fixedTokens: 10_001 },
      }),
    ).toThrow("No further history compaction can make this request fit");

    const queued = prepareWithFactParity(entries, {
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
    const planned = prepareWithFactParity(entries, configured);
    expect(planned.status).toBe("prepared");
    if (planned.status !== "prepared") {
      throw new Error("Expected manual minimum-tail preparation");
    }
    expect(planned.preparation.firstKeptEntryId).toBe("recent");
    expect(planned.preparation.settings.keepRecentTokens).toBe(0);
    expect(configured.settings.keepRecentTokens).toBe(10_000);
    expect(prepareWithFactParity(entries, { ...configured, mode: "auto" })).toEqual({
      status: "skipped",
      reason: "Nothing to compact (session too small)",
    });
    expect(
      prepareWithFactParity(entries, {
        ...configured,
        summaryOutputPolicy: "retry-invalid-once",
      }),
    ).toEqual({ status: "skipped", reason: "Nothing to compact (session too small)" });
  });

  it("shares fallback pressure, reset selection, manual errors and scalar standalone costs", () => {
    const history = userEntry("history", "Older work. ".repeat(100));
    const recent = userEntry("recent", "Recent work.", history.id);
    const base = options();
    const entries: SessionEntry[] = [history, recent];
    const fallback = {
      ...base,
      mode: "auto" as const,
      requestBudget: {
        ...base.requestBudget,
        pendingTokens: 0,
        reserveTokens: 20_000,
      },
    };
    expect(prepareWithFactParity(entries, fallback).status).toBe("prepared");
    expect(
      prepareWithFactParity(entries, {
        ...base,
        requestBudget: undefined,
        summaryOutputPolicy: "deterministic",
        contextWindow: 100_000,
        systemPrompt: "Fixed instructions",
        tools: [{ name: "read", description: "Read a file", parameters: {} }],
        settings: { ...base.settings, maxSummaryChars: MAX_COMPACTION_SUMMARY_CHARS + 1 },
      }).status,
    ).toBe("prepared");
    const reset: SessionEntry = {
      type: "reset",
      reason: "new",
      id: "reset",
      parentId: recent.id,
      timestamp: recent.timestamp,
      firstKeptEntryId: recent.id,
    };
    const after = userEntry("after", "Post-reset history.", reset.id);
    expect(
      prepareWithFactParity(
        [...entries, reset, after, userEntry("latest", "Newest request.", after.id)],
        fallback,
      ).status,
    ).toBe("prepared");
    expect(() => prepareWithFactParity([], { ...base, requestBudget: undefined })).toThrow(
      "Nothing to compact (session too small)",
    );
    expect(() =>
      prepareWithFactParity(
        [
          {
            type: "compaction",
            id: "done",
            parentId: null,
            timestamp: recent.timestamp,
            firstKeptEntryId: "absent",
            summary: "Done",
            tokensBefore: 10,
            fromHook: true,
          },
        ],
        { ...base, requestBudget: undefined },
      ),
    ).toThrow("Already compacted");
    expect(() =>
      prepareWithFactParity([recent], {
        ...fallback,
        requestBudget: { ...fallback.requestBudget, contextWindow: 20 },
      }),
    ).toThrow("No further history compaction can make this request fit");
    expect(() =>
      prepareWithFactParity(entries, {
        ...fallback,
        requestFromEntryId: "missing-request",
        requestState: "unresolved",
      }),
    ).toThrow("Compaction cannot find the admitted request");
  });
});
