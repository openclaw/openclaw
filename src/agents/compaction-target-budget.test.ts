import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { FileOperations, SessionEntry } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  rebuildCompactionPreparationForKeepRecentTokens,
  runTargetBudgetCompaction,
  type CompactionPreparationLike,
} from "./compaction-target-budget.js";

function createFileOps(): FileOperations {
  return {
    read: new Set<string>(),
    written: new Set<string>(),
    edited: new Set<string>(),
  };
}

function createUserMessage(content: string, timestamp: number): AgentMessage {
  return {
    role: "user",
    content,
    timestamp,
  };
}

function createAssistantMessage(text: string, timestamp: number): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp,
  } as unknown as AgentMessage;
}

function createMessageEntry(id: string, message: AgentMessage): SessionEntry {
  return {
    id,
    type: "message",
    message,
    timestamp: message.timestamp,
  } as unknown as SessionEntry;
}

function createBranchEntries(): SessionEntry[] {
  return [
    createMessageEntry("entry-1", createUserMessage("older ask", 1)),
    createMessageEntry("entry-2", createAssistantMessage("a".repeat(120), 2)),
    createMessageEntry("entry-3", createUserMessage("middle ask", 3)),
    createMessageEntry("entry-4", createAssistantMessage("b".repeat(120), 4)),
    createMessageEntry("entry-5", createUserMessage("recent ask", 5)),
    createMessageEntry("entry-6", createAssistantMessage("c".repeat(120), 6)),
  ];
}

function createBasePreparation(): CompactionPreparationLike {
  return {
    firstKeptEntryId: "entry-5",
    messagesToSummarize: [
      createUserMessage("older ask", 1),
      createAssistantMessage("a".repeat(120), 2),
      createUserMessage("middle ask", 3),
      createAssistantMessage("b".repeat(120), 4),
    ],
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 120,
    previousSummary: undefined,
    fileOps: createFileOps(),
    settings: {
      enabled: true,
      reserveTokens: 4_000,
      keepRecentTokens: 40,
    },
  };
}

describe("rebuildCompactionPreparationForKeepRecentTokens", () => {
  it("moves the keep boundary later when keepRecentTokens shrink", () => {
    const rebuilt = rebuildCompactionPreparationForKeepRecentTokens({
      branchEntries: createBranchEntries(),
      basePreparation: createBasePreparation(),
      keepRecentTokens: 10,
    });

    expect(rebuilt).toBeDefined();
    expect(rebuilt?.firstKeptEntryId).toBe("entry-6");
    expect(rebuilt?.messagesToSummarize.length).toBeGreaterThanOrEqual(
      createBasePreparation().messagesToSummarize.length,
    );
    expect(rebuilt?.settings.keepRecentTokens).toBe(10);
  });
});

describe("runTargetBudgetCompaction", () => {
  it("retries with smaller retained history until the target is met", async () => {
    const execute = vi.fn(async (preparation: CompactionPreparationLike) => ({
      summary: "",
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
    }));

    const outcome = await runTargetBudgetCompaction({
      branchEntries: createBranchEntries(),
      basePreparation: createBasePreparation(),
      targetTokens: 60,
      liveContextTokens: 140,
      execute,
    });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(outcome.targetReached).toBe(true);
    expect(outcome.estimatedFullTokensAfter).toBeLessThanOrEqual(60);
    expect(outcome.preparation.settings.keepRecentTokens).toBeLessThan(40);
  });

  it("warns and returns the smallest attempt when fixed overhead already exceeds the target", async () => {
    const execute = vi.fn(async (preparation: CompactionPreparationLike) => ({
      summary: "summary",
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
    }));

    const outcome = await runTargetBudgetCompaction({
      branchEntries: createBranchEntries(),
      basePreparation: createBasePreparation(),
      targetTokens: 40,
      liveContextTokens: 220,
      execute,
    });

    expect(outcome.targetReached).toBe(false);
    expect(outcome.fixedOverheadTokens).toBe(100);
    expect(outcome.warnings.join(" ")).toContain("below fixed overhead");
    expect(execute).toHaveBeenCalled();
  });
});
