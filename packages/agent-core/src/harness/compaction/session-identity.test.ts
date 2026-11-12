import { expect, it, vi } from "vitest";
import type { StreamFn } from "../../llm.js";
import type { AgentCoreCompletionRuntimeDeps } from "../../runtime-deps.js";
import { generateBranchSummary } from "./branch-summarization.js";
import { compact, generateSummary, type CompactionPreparation } from "./compaction.js";
import { createCompactionModel, createMessageEntry } from "./compaction.test-support.js";
import { assistant, responseStream, user } from "./shard-fixtures.test-support.js";
import { createFileOps } from "./utils.js";

const model = createCompactionModel();

it.each(["complete", "stream"] as const)(
  "keeps concurrent summary requests bound to their session through %s",
  async (transport) => {
    const pending: Array<() => void> = [];
    const seen: Array<string | undefined> = [];
    const complete: NonNullable<AgentCoreCompletionRuntimeDeps["completeSimple"]> = vi.fn(
      async (_model, _context, options) => {
        seen.push(options?.sessionId);
        await new Promise<void>((resolve) => {
          pending.push(resolve);
        });
        return assistant("Summary");
      },
    );
    const streamFn: StreamFn = async (_model, _context, options) => {
      const reply = await complete(_model, _context, options);
      return responseStream(reply);
    };
    const runtime = transport === "complete" ? { completeSimple: complete } : undefined;
    const stream = transport === "stream" ? streamFn : undefined;
    const sessions = ["session-a", "session-b", undefined];
    const calls = sessions.flatMap((sessionId) => [
      generateSummary(
        [user("Summarize history")],
        model,
        1_000,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        stream,
        runtime,
        undefined,
        sessionId,
      ),
      generateBranchSummary([createMessageEntry(user("Summarize branch"), 0)], {
        model,
        apiKey: "test-key",
        signal: new AbortController().signal,
        streamFn: stream,
        runtime,
        sessionId,
      }),
    ]);
    // All requests enter before any completes, including the identity-less SDK caller.
    try {
      expect(seen).toEqual([
        "session-a",
        "session-a",
        "session-b",
        "session-b",
        undefined,
        undefined,
      ]);
    } finally {
      pending.toReversed().forEach((release) => release());
      await Promise.all(calls);
    }
    const results = await Promise.all(calls);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(seen).toEqual([
      "session-a",
      "session-a",
      "session-b",
      "session-b",
      undefined,
      undefined,
    ]);
  },
);

it("forwards each compaction owner's identity to history and split-turn requests", async () => {
  const seen: Array<string | undefined> = [];
  const complete: NonNullable<AgentCoreCompletionRuntimeDeps["completeSimple"]> = async (
    _model,
    _context,
    options,
  ) => {
    seen.push(options?.sessionId);
    return assistant("Summary");
  };
  const preparation: CompactionPreparation = {
    firstKeptEntryId: "retained-entry",
    messagesToSummarize: [user("Earlier history")],
    turnPrefixMessages: [user("Split turn prefix")],
    isSplitTurn: true,
    tokensBefore: 10_000,
    fileOps: createFileOps(),
    settings: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 1_000 },
  };
  const results = await Promise.all(
    ["session-a", "session-b"].map((sessionId) =>
      compact(
        preparation,
        model,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { completeSimple: complete },
        sessionId,
      ),
    ),
  );
  expect(results.every((result) => result.ok)).toBe(true);
  expect(seen).toEqual(["session-a", "session-b", "session-a", "session-b"]);
});
