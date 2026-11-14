import { assert, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream } from "../../llm.js";
import type { AssistantMessage, Model, StreamFn, Usage } from "../../llm.js";
import type { AgentMessage } from "../../types.js";
import {
  InvalidSummaryOutputError,
  SummaryOutputBudgetError,
  type SessionTreeEntry,
} from "../types.js";
import {
  calculateContextTokens,
  compactWithoutSummary,
  MAX_COMPACTION_SUMMARY_CHARS,
  estimateContextTokens,
  estimateTokens,
  findCutPoint,
  getLastAssistantUsage,
  prepareCompaction,
  shouldCompact,
} from "./compaction.js";
import {
  createCompactionModel,
  createContextUsage as createUsage,
  createMessageEntry,
} from "./compaction.test-support.js";
import {
  assistant,
  bash,
  compactWith,
  custom,
  decoratedResponse,
  responseStream,
  summarize,
  text,
  toolCall,
  toolResult,
  user,
} from "./shard-fixtures.test-support.js";
import { compactionEntry, modelReply, userEntry } from "./summary-capture.test-support.js";
import { createFileOps } from "./utils.js";

function prepare(
  entries: SessionTreeEntry[],
  settings = { enabled: true, reserveTokens: 0, keepRecentTokens: 1 },
  requestState?: "unresolved",
) {
  const result = prepareCompaction(entries, settings, requestState);
  assert(result.ok && result.value, "expected compactable history");
  return result.value;
}

function resetEntry(index: number, firstKeptEntryId?: string): SessionTreeEntry {
  return {
    type: "reset",
    id: `entry-${index}`,
    parentId: `entry-${index - 1}`,
    timestamp: new Date(index + 1).toISOString(),
    reason: "new",
    ...(firstKeptEntryId ? { firstKeptEntryId } : {}),
  };
}

function createAssistant(value: string, usage: Usage, timestamp: number) {
  return assistant(value, { usage, timestamp });
}

function assistantEntry(value: string, index: number, tokens = 2) {
  return createMessageEntry(createAssistant(value, createUsage(tokens), index + 1), index);
}

function createBashMessage(output: string, timestamp: number, excludeFromContext: boolean) {
  return bash(output, { command: "print output", timestamp, excludeFromContext });
}

function createProjectedEntry(
  type: "custom_message" | "branch_summary",
  index: number,
  content: string,
): SessionTreeEntry {
  const common = {
    id: `entry-${index}`,
    parentId: index === 0 ? null : `entry-${index - 1}`,
    timestamp: new Date(index + 1).toISOString(),
  };
  return type === "custom_message"
    ? { ...common, type, customType: "test", content, display: true }
    : { ...common, type, fromId: common.parentId ?? common.id, summary: content };
}

it.each([
  [1, 0, true, false],
  [749_999, 1_000_000, true, false],
  [750_001, 1_000_000, true, true],
  [923_326, 1_000_000, true, true],
  [923_326, 1_000_000, false, false],
])("compacts %i tokens in a %i window (enabled: %s)", (tokens, window, enabled, expected) => {
  expect(
    shouldCompact(tokens, window, { enabled, reserveTokens: 20_000, keepRecentTokens: 20_000 }),
  ).toBe(expected);
});

describe("calculateContextTokens", () => {
  const aggregateUsage: Usage = {
    ...createUsage(927_907),
    input: 12,
    output: 15_104,
    cacheRead: 819_661,
    cacheWrite: 93_130,
    contextUsage: { state: "unavailable" },
  };

  it("prefers the final-iteration context snapshot over aggregate billing usage", () => {
    expect(
      calculateContextTokens({
        ...aggregateUsage,
        contextUsage: { state: "available", promptTokens: 148_874, totalTokens: 163_978 },
      }),
    ).toBe(163_978);
  });

  it("uses the previous exact snapshot and estimates only the unavailable tail", () => {
    const estimate = estimateContextTokens([
      createAssistant(
        "previous",
        {
          ...createUsage(149_874),
          input: 12,
          output: 1_000,
          cacheRead: 148_862,
          contextUsage: { state: "available", promptTokens: 148_874, totalTokens: 149_874 },
        },
        0,
      ),
      { role: "user", content: "next", timestamp: 1 },
      createAssistant("done", aggregateUsage, 2),
    ]);

    expect(estimate).toMatchObject({ usageTokens: 149_874, lastUsageIndex: 0 });
    expect(estimate.tokens).toBeGreaterThan(149_874);
    expect(estimate.tokens).toBeLessThan(927_907);
  });

  it("does not scan past a zero unavailable context marker", () => {
    const messages: AgentMessage[] = [
      createAssistant("old cumulative turn", createUsage(950), 0),
      createAssistant(
        "usage unavailable",
        { ...createUsage(0), contextUsage: { state: "unavailable" } },
        1,
      ),
    ];
    const estimate = estimateContextTokens(messages);

    expect(estimate).toMatchObject({ usageTokens: 0, lastUsageIndex: null });
    expect(estimate.tokens).toBeGreaterThan(0);
    expect(estimate.tokens).toBeLessThan(950);
    expect(getLastAssistantUsage(messages.map(createMessageEntry))).toBeUndefined();
  });

  it("treats legacy CLI usage without context provenance as a barrier", () => {
    const legacyCli = {
      ...createAssistant("legacy CLI", createUsage(950), 1),
      api: "cli",
      usage: { ...createUsage(950), contextUsage: undefined },
    };
    const messages = [createAssistant("old", createUsage(900), 0), legacyCli];

    expect(estimateContextTokens(messages).usageTokens).toBe(0);
    expect(getLastAssistantUsage(messages.map(createMessageEntry))).toBeUndefined();
  });

  it.each(["all-zero", "sparse"] as const)("scans past an %s assistant tail", (kind) => {
    const validUsage = createUsage(20);
    const sparseAssistant = {
      role: "assistant",
      content: [text("seeded without provider usage")],
      api: "test-api",
      provider: "test-provider",
      model: "test-model",
      stopReason: "stop",
      timestamp: 2,
    } as AgentMessage;
    const tail =
      kind === "all-zero"
        ? [user("continue", 2), createAssistant("partial", createUsage(0), 3)]
        : [sparseAssistant];
    const messages = [createAssistant("complete", validUsage, 1), ...tail];
    expect(getLastAssistantUsage(messages.map(createMessageEntry))).toBe(validUsage);
    expect(estimateContextTokens(messages)).toMatchObject({ usageTokens: 20, lastUsageIndex: 0 });
    expect(estimateContextTokens(messages).trailingTokens).toBeGreaterThan(0);
  });
});

describe("session-entry compaction budgeting", () => {
  it("counts visible shell activity while ignoring excluded activity after provider usage", () => {
    const hidden = createBashMessage("x".repeat(80_000), 2, true);
    const visible = createBashMessage("x".repeat(80_000), 2, false);
    const lastAssistant = createAssistant("done", createUsage(42), 1);
    const latest: AgentMessage = { role: "user", content: "continue", timestamp: 3 };

    expect(estimateTokens(hidden)).toBe(0);
    expect(estimateTokens(visible)).toBeGreaterThan(20_000);
    expect(estimateContextTokens([lastAssistant, hidden, latest])).toMatchObject({
      tokens: 44,
      usageTokens: 42,
      trailingTokens: 2,
      lastUsageIndex: 0,
    });
    expect(estimateContextTokens([lastAssistant, visible, latest]).trailingTokens).toBeGreaterThan(
      20_000,
    );
  });

  it("omits private shell history from a genuine split-turn summary prefix", () => {
    const latestRequest = `request-start ${"x".repeat(1_000)} request-end`;
    const entries: SessionTreeEntry[] = [
      userEntry(latestRequest, 0),
      assistantEntry("earlier work", 1, 10),
      createMessageEntry(createBashMessage("private output ".repeat(6_000), 3, true), 2),
      assistantEntry("latest", 3, 10),
    ];

    expect(findCutPoint(entries, 0, entries.length, 1)).toEqual({
      firstKeptEntryIndex: 3,
      turnStartIndex: 0,
      isSplitTurn: true,
    });

    const preparation = prepare(entries, undefined, "unresolved");
    expect(preparation).toMatchObject({
      firstKeptEntryId: "entry-3",
      isSplitTurn: true,
      tokensBefore: 10,
      turnPrefixMessages: [{ role: "user" }, { role: "assistant" }],
    });
    expect(preparation.latestUnresolvedUserRequest).toHaveLength(800);
    expect(preparation.latestUnresolvedUserRequest).toMatch(
      /^request-start .+\[\.\.\. latest user request truncated \.\.\.\].+ request-end$/s,
    );
    expect(preparation).not.toHaveProperty("splitTurnCompleted");
    expect(JSON.stringify(preparation)).not.toContain("private output");
    expect(JSON.stringify(entries)).toContain("private output");
  });

  it("uses CJK-aware token estimates when choosing the retained tail", () => {
    const entries: SessionTreeEntry[] = [
      userEntry("start", 0),
      assistantEntry("ok", 1),
      userEntry("早上好", 2),
      assistantEntry("ok", 3),
      userEntry("你好世界", 4),
    ];

    expect(findCutPoint(entries, 0, entries.length, 4)).toEqual({
      firstKeptEntryIndex: 4,
      turnStartIndex: -1,
      isSplitTurn: false,
    });
  });

  it.each(["custom_message", "branch_summary"] as const)(
    "counts a %s entry that projects into model context",
    (entryType) => {
      const entries: SessionTreeEntry[] = [
        userEntry("hi", 0),
        assistantEntry("hello", 1),
        createProjectedEntry(entryType, 2, "x".repeat(4_000)),
        assistantEntry("ok", 3),
      ];

      expect(findCutPoint(entries, 0, entries.length, 1)).toMatchObject({
        firstKeptEntryIndex: 3,
        turnStartIndex: 2,
        isSplitTurn: true,
      });
      expect(findCutPoint(entries, 0, entries.length, 2)).toEqual({
        firstKeptEntryIndex: 2,
        turnStartIndex: -1,
        isSplitTurn: false,
      });
    },
  );

  it("plans provider-triggered cuts in provider token units", () => {
    const entries = [
      userEntry("first", 0),
      assistantEntry("ok", 1),
      userEntry("second", 2),
      assistantEntry("ok", 3),
      userEntry("latest", 4),
      assistantEntry("done", 5, 170_000),
    ];

    const result = prepare(entries, {
      enabled: true,
      reserveTokens: 16_384,
      keepRecentTokens: 20_000,
    });

    expect(result).toMatchObject({ firstKeptEntryId: "entry-4" });
    expect(result.messagesToSummarize.length).toBeGreaterThan(0);
  });

  const readCall = (timestamp: number) =>
    assistant([toolCall("read", {}, "call-1")], {
      usage: createUsage(2),
      timestamp,
      stopReason: "toolUse",
    });
  it.each([
    {
      name: "orphan-only",
      middle: [
        toolResult("hidden tool result", { timestamp: 3 }),
        createAssistant("kept answer", createUsage(2), 4),
      ],
      kept: [],
      excluded: "hidden tool result",
      checkCut: true,
    },
    {
      name: "occurrence-paired",
      middle: [
        readCall(3),
        toolResult("first result", { timestamp: 4 }),
        readCall(5),
        toolResult("second result", { timestamp: 6 }),
        toolResult("orphan result", { timestamp: 7 }),
      ],
      kept: ["first result", "second result"],
      excluded: "orphan result",
      checkCut: false,
    },
  ])("filters $name reset tool rows before compaction", ({ middle, kept, excluded, checkCut }) => {
    const resetIndex = middle.length + 2;
    const entries = [
      userEntry("discarded", 0),
      userEntry("kept question", 1),
      ...middle.map((message, index) => createMessageEntry(message, index + 2)),
      resetEntry(resetIndex, "entry-1"),
      userEntry("post reset", resetIndex + 1),
      assistantEntry("new answer", resetIndex + 2),
    ];
    const result = prepare(entries);
    const summarized = JSON.stringify(result.messagesToSummarize);
    for (const value of kept) {
      expect(summarized).toContain(value);
    }
    expect(summarized).not.toContain(excluded);
    expect(JSON.stringify(result.turnPrefixMessages)).not.toContain(excluded);
    if (checkCut) {
      expect(["entry-5", "entry-6"]).toContain(result.firstKeptEntryId);
    }
  });

  it("moves the cut earlier when a reset kept-tail prelude consumes the compaction budget", () => {
    const largePrelude = "kept context ".repeat(4_000);
    const buildEntries = (firstKeptEntryId?: string): SessionTreeEntry[] => [
      userEntry(largePrelude, 0),
      resetEntry(1, firstKeptEntryId),
      createMessageEntry(user("post one ".repeat(500), 4), 2),
      createMessageEntry(createAssistant("answer one ".repeat(500), createUsage(2), 5), 3),
      createMessageEntry(user("post two ".repeat(500), 6), 4),
      createMessageEntry(createAssistant("answer two ".repeat(500), createUsage(2), 7), 5),
    ];
    const settings = { enabled: true, reserveTokens: 0, keepRecentTokens: 500 };
    const withoutPrelude = prepare(buildEntries(), settings);
    const withPrelude = prepare(buildEntries("entry-0"), settings);
    const cutIndex = (entryId: string) => Number.parseInt(entryId.slice("entry-".length), 10);
    expect(cutIndex(withPrelude.firstKeptEntryId)).toBeLessThan(
      cutIndex(withoutPrelude.firstKeptEntryId),
    );
  });
});

describe("prepareCompaction when the last entry is a compaction record", () => {
  const settings = { enabled: true, reserveTokens: 0, keepRecentTokens: 1 };
  it.each([
    { name: "ordinary", fromHook: false, compactable: true },
    { name: "safeguard", fromHook: true, compactable: false },
  ])("handles a $name trailing compaction boundary", ({ fromHook, compactable }) => {
    const largeContent = "x".repeat(200_000);
    const entries: SessionTreeEntry[] = [
      userEntry("original request", 0),
      compactionEntry(1, "earlier summary", "entry-0", { id: "compaction-1" }),
      userEntry(largeContent, 2),
      assistantEntry(largeContent, 3, 10),
      userEntry(largeContent, 4),
      assistantEntry("recent reply tail", 5, 10),
      compactionEntry(6, "later summary", "entry-2", { id: "compaction-2", fromHook }),
    ];

    const result = prepareCompaction(entries, settings);

    expect(result.ok).toBe(true);
    expect(Boolean(result.ok && result.value)).toBe(compactable);
    if (!compactable) {
      return;
    }
    assert(result.ok && result.value, "expected compactable trailing boundary");
    expect(result.value.messagesToSummarize.length).toBeGreaterThan(0);
    expect(result.value.previousSummary).toBe("later summary");
    expect(result.value.firstKeptEntryId).not.toBe("entry-2");

    const nextResult = prepareCompaction(
      [
        ...entries,
        compactionEntry(7, "final summary", result.value.firstKeptEntryId, {
          id: "compaction-3",
          parentId: "compaction-2",
          tokensBefore: result.value.tokensBefore,
        }),
      ],
      settings,
    );

    expect(nextResult).toEqual({ ok: true, value: undefined });
  });

  it("ignores missing fields in persisted compaction details", () => {
    const largeContent = "x".repeat(200_000);
    const entries: SessionTreeEntry[] = [
      userEntry("original request", 0),
      compactionEntry(1, "earlier summary", "entry-0", { details: { readFiles: ["src/read.ts"] } }),
      userEntry(largeContent, 2),
      assistantEntry(largeContent, 3, 10),
      userEntry("recent tail", 4),
    ];

    const result = prepare(entries, settings);

    expect(result).toMatchObject({
      previousSummaryDetails: undefined,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
    });
  });
});

describe("generateSummary progress updates", () => {
  it("asks to keep completed checks distinct from unresolved blockers", async () => {
    const completeSimple = vi.fn(async () => createAssistant("summary", createUsage(1), 4));
    const result = await summarize(
      [
        user("Check whether the release is approved."),
        assistant([toolCall("verify", {}, "check")], { timestamp: 2, stopReason: "toolUse" }),
        toolResult("Verification FAILED: missing release approval.", {
          toolCallId: "check",
          toolName: "verify",
          isError: true,
          timestamp: 3,
        }),
      ],
      createCompactionModel(),
      { previousSummary: "Release approval check: pending.", runtime: { completeSimple } },
    );

    expect(result.ok).toBe(true);
    const request = JSON.stringify(completeSimple.mock.calls);
    expect(request).toContain("Release approval check: pending.");
    expect(request).toContain("Verification FAILED: missing release approval.");
    expect(request).toContain("Record checks that ran and their results as completed");
    expect(request).toContain("keep unresolved blockers separate");
  });
});

describe("generateSummary thinking options", () => {
  it("consumes the decorated stream before reading its result", async () => {
    const model = createCompactionModel();
    const { streamFn, consumed } = decoratedResponse(createAssistant("summary", createUsage(1), 1));

    await summarize([user("hello")], model, { streamFn });

    expect(consumed()).toBe(true);
  });

  it("maps explicit Fable off to low effort for compaction", async () => {
    const model: Model = {
      ...createCompactionModel({
        id: "production-fable",
        name: "Production Fable",
        contextWindow: 1_000_000,
        maxTokens: 128_000,
      }),
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      params: { canonicalModelId: "claude-fable-5" },
    };
    const summaryMessage = modelReply(model, "summary");
    const streamFn = vi.fn<StreamFn>((_model, context, options) => {
      expect(options?.reasoning).toBe("low");
      expect(context.systemPrompt).toContain("user and an AI assistant");
      expect(context.systemPrompt).not.toContain("AI coding assistant");
      return responseStream(summaryMessage);
    });

    const result = await summarize([user("hello")], model, { streamFn, thinkingLevel: "off" });

    expect(result).toEqual({ ok: true, value: "summary" });
    expect(streamFn).toHaveBeenCalledOnce();
  });

  it.each(["stop", "length"] as const)(
    "classifies empty summary output after a %s stop",
    async (stopReason) => {
      const exhausted = stopReason === "length";
      const content: AssistantMessage["content"] = exhausted
        ? [{ type: "thinking", thinking: "internal summary reasoning" }]
        : [text(" \n\t ")];
      const model = createCompactionModel({ reasoning: true });
      const streamFn = vi.fn<StreamFn>(() =>
        responseStream(
          assistant(content, {
            usage: createUsage(exhausted ? 800 : 1),
            model: model.id,
            stopReason,
          }),
        ),
      );
      const result = await summarize([user("hello")], model, {
        streamFn,
        thinkingLevel: exhausted ? "high" : "low",
      });
      assert(!result.ok);
      expect(streamFn).toHaveBeenCalledOnce();
      expect(result.error).toBeInstanceOf(
        exhausted ? SummaryOutputBudgetError : InvalidSummaryOutputError,
      );
      expect(result.error).toMatchObject({
        name: "CompactionError",
        code: "summarization_failed",
        message: exhausted
          ? expect.stringContaining(
              "output budget (800 tokens) was exhausted without visible text for test-provider/summary-model (model maxTokens: 8000); " +
                'set agents.defaults.compaction.thinkingLevel to "off" if supported, or use agents.defaults.compaction.model to select a model that can summarize within this budget',
            )
          : "Summarization failed: model returned no summary text",
      });
    },
  );
});

describe("split-turn compaction", () => {
  const operatorFocus = "Preserve API decisions.";
  const runtimeContext = custom("PRIVATE_RUNTIME_CONTEXT", {
    customType: "openclaw.runtime-context",
    display: false,
    details: { source: "openclaw-runtime-context", runtimeContextCarrier: true },
  });
  it.each([
    { name: "prefix-only", history: false, budgets: [500] },
    {
      name: "caller-owned instructions",
      history: true,
      budgets: [800, 500],
      focus: `<policy>${"preserve generated policy ".repeat(200)}</policy>`,
    },
  ])(
    "forwards focus and serializes $name summaries",
    async ({ history, budgets, focus = operatorFocus }) => {
      const model = createCompactionModel();
      const prompts: string[] = [];
      const outputBudgets: Array<number | undefined> = [];
      const usageSink = vi.fn();
      let active = 0;
      let maxActive = 0;
      const streamFn = vi.fn<StreamFn>((_model, context, options) => {
        const message = context.messages[0];
        if (message?.role !== "user") {
          throw new Error("expected a user summary prompt");
        }
        prompts.push(
          typeof message.content === "string"
            ? message.content
            : message.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
        );
        outputBudgets.push(options?.maxTokens);
        active++;
        maxActive = Math.max(maxActive, active);
        const stream = createAssistantMessageEventStream();
        setTimeout(() => {
          active--;
          const usage = createUsage(outputBudgets.length * 10 + 1);
          const response = createAssistant("summary", usage, 1);
          response.model = model.id;
          stream.push({ type: "done", reason: "stop", message: response });
          stream.end();
        }, 5);
        return stream;
      });
      const result = await compactWith(
        {
          firstKeptEntryId: "kept-entry",
          messagesToSummarize: history ? [user("history"), runtimeContext] : [],
          turnPrefixMessages: [user("prefix", 2), runtimeContext],
          isSplitTurn: true,
          tokensBefore: 100,
          fileOps: createFileOps(),
          settings: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 100 },
        },
        model,
        {
          customInstructions: focus,
          streamFn,
          runtime: { completeSimple: vi.fn(), internalUsageSink: usageSink },
        },
      );

      expect(result.ok).toBe(true);
      expect(streamFn).toHaveBeenCalledTimes(budgets.length);
      expect(maxActive).toBe(1);
      expect(outputBudgets).toEqual(budgets);
      expect(usageSink.mock.calls.map(([usage]) => usage.totalTokens)).toEqual(
        budgets.map((_, index) => (index + 1) * 10 + 1),
      );
      for (const prompt of prompts) {
        expect(prompt).toContain(focus);
        expect(prompt).not.toContain("PRIVATE_RUNTIME_CONTEXT");
        expect(prompt.indexOf(focus)).toBeGreaterThan(prompt.lastIndexOf("</conversation>"));
      }
      expect(prompts.at(-1)).toContain("## Original Request");
      expect(prompts.at(-1)).not.toContain("## Goal");
      if (history) {
        expect(prompts[0]).toContain("## Goal");
        expect(prompts[0]).not.toContain("## Original Request");
      }
    },
  );
});

describe("compactWithoutSummary", () => {
  const lossNotice = "2 earlier message(s) were removed without a summary";
  // About 1,200 characters with the constraint in the middle: inside the 2,000-character
  // split-turn ask bound, beyond the 800-character unresolved-request bound.
  const filler = "Context for the split request. ".repeat(19);
  const sourceAsk = `${filler}Constraint: keep SOURCE-ASK-MIDDLE. ${filler}`.trim();
  it("keeps the loss notice, source ask, and unresolved request beside a constrained foreground budget", () => {
    const result = compactWithoutSummary({
      firstKeptEntryId: "kept-entry",
      messagesToSummarize: [user("history")],
      turnPrefixMessages: [user(sourceAsk, 2)],
      isSplitTurn: true,
      latestUnresolvedUserRequest: "finish the review",
      previousSummary: "p".repeat(MAX_COMPACTION_SUMMARY_CHARS),
      tokensBefore: 100,
      fileOps: createFileOps(),
      settings: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 100 },
      summaryTokenBudget: 450,
    });

    expect(result.ok).toBe(true);
    const summary = result.ok ? result.value.summary : "";
    expect(summary.length).toBeLessThanOrEqual(MAX_COMPACTION_SUMMARY_CHARS);
    expect(summary).toContain(lossNotice);
    expect(summary).toContain('"finish the review"');
    expect(sourceAsk.length).toBeGreaterThan(1_100);
    expect(summary).toContain(JSON.stringify(sourceAsk));
    expect(result.ok && result.value.firstKeptEntryId).toBe("kept-entry");
  });
});
