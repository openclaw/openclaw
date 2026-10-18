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
  compact,
  compactWithoutSummary,
  MAX_COMPACTION_SUMMARY_CHARS,
  estimateContextTokens,
  estimateTokens,
  findCutPoint,
  generateSummary,
  getLastAssistantUsage,
  prepareCompaction,
  shouldCompact,
} from "./compaction.js";
import {
  createCompactionModel,
  createContextUsage as createUsage,
  createMessageEntry,
} from "./compaction.test-support.js";
import { createFileOps } from "./utils.js";

type SummaryArgs = Parameters<typeof generateSummary>;
function summarize(
  messages: AgentMessage[],
  model: Model,
  streamFn: StreamFn | undefined,
  options: { previous?: string; thinking?: SummaryArgs[8]; runtime?: SummaryArgs[10] } = {},
) {
  return generateSummary(
    messages,
    model,
    1_000,
    undefined,
    undefined,
    undefined,
    undefined,
    options.previous,
    options.thinking,
    streamFn,
    options.runtime,
  );
}

function userEntry(content: string, index: number) {
  return createMessageEntry({ role: "user", content, timestamp: index + 1 }, index);
}

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

function responseStream(message: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  const reason = message.stopReason;
  if (reason !== "stop" && reason !== "length" && reason !== "toolUse") {
    throw new Error("expected completed summary response");
  }
  stream.push({ type: "done", reason, message });
  stream.end();
  return stream;
}

function createSummaryModel(reasoning = false): Model {
  return createCompactionModel({ reasoning });
}

function createAssistant(text: string, usage: Usage, timestamp: number): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "test-api",
    provider: "test-provider",
    model: "test-model",
    usage,
    stopReason: "stop",
    timestamp,
  };
}

function createBashMessage(
  output: string,
  timestamp: number,
  excludeFromContext: boolean,
): AgentMessage {
  return {
    role: "bashExecution",
    command: "print output",
    output,
    exitCode: 0,
    cancelled: false,
    truncated: false,
    timestamp,
    excludeFromContext,
  };
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

describe("shouldCompact", () => {
  it("skips an invalid context window of zero", () => {
    expect(
      shouldCompact(1, 0, {
        enabled: true,
        reserveTokens: 16_384,
        keepRecentTokens: 20_000,
      }),
    ).toBe(false);
  });
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

    expect(estimate.usageTokens).toBe(149_874);
    expect(estimate.tokens).toBeGreaterThan(149_874);
    expect(estimate.tokens).toBeLessThan(927_907);
    expect(estimate.lastUsageIndex).toBe(0);
  });

  it("does not scan past a zero unavailable context marker", () => {
    const messages: AgentMessage[] = [
      createAssistant("old cumulative turn", createUsage(950), 0),
      {
        ...createAssistant("usage unavailable", createUsage(0), 1),
        usage: {
          ...createUsage(0),
          contextUsage: { state: "unavailable" },
        },
      },
    ];
    const estimate = estimateContextTokens(messages);

    expect(estimate.usageTokens).toBe(0);
    expect(estimate.lastUsageIndex).toBeNull();
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

  it("ignores an all-zero terminal usage block", () => {
    const validUsage = createUsage(20);
    const messages: AgentMessage[] = [
      createAssistant("complete", validUsage, 1),
      { role: "user", content: "continue", timestamp: 2 },
      createAssistant("partial", createUsage(0), 3),
    ];
    const entries = messages.map(createMessageEntry);

    expect(getLastAssistantUsage(entries)).toBe(validUsage);
    expect(estimateContextTokens(messages)).toMatchObject({
      usageTokens: 20,
      lastUsageIndex: 0,
    });
    expect(estimateContextTokens(messages).trailingTokens).toBeGreaterThan(0);
  });

  it("scans past a sparse assistant row to retain older valid usage", () => {
    const validUsage = createUsage(20);
    const sparseAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "seeded without provider usage" }],
      api: "test-api",
      provider: "test-provider",
      model: "test-model",
      stopReason: "stop",
      timestamp: 2,
    } as AgentMessage;
    const messages = [createAssistant("complete", validUsage, 1), sparseAssistant];

    expect(getLastAssistantUsage(messages.map(createMessageEntry))).toBe(validUsage);
    expect(estimateContextTokens(messages)).toMatchObject({
      usageTokens: 20,
      lastUsageIndex: 0,
    });
    expect(estimateContextTokens(messages).trailingTokens).toBeGreaterThan(0);
  });
});

describe("session-entry compaction budgeting", () => {
  it("counts visible shell activity while ignoring excluded activity after provider usage", () => {
    const hidden = createBashMessage("x".repeat(80_000), 2, true);
    const visible = createBashMessage("x".repeat(80_000), 2, false);
    const assistant = createAssistant("done", createUsage(42), 1);
    const latest: AgentMessage = { role: "user", content: "continue", timestamp: 3 };

    expect(estimateTokens(hidden)).toBe(0);
    expect(estimateTokens(visible)).toBeGreaterThan(20_000);
    expect(estimateContextTokens([assistant, hidden, latest])).toMatchObject({
      tokens: 44,
      usageTokens: 42,
      trailingTokens: 2,
      lastUsageIndex: 0,
    });
    expect(estimateContextTokens([assistant, visible, latest]).trailingTokens).toBeGreaterThan(
      20_000,
    );
  });

  it("omits private shell history from a genuine split-turn summary prefix", () => {
    const latestRequest = `request-start ${"x".repeat(1_000)} request-end`;
    const entries: SessionTreeEntry[] = [
      userEntry(latestRequest, 0),
      createMessageEntry(createAssistant("earlier work", createUsage(10), 2), 1),
      createMessageEntry(createBashMessage("private output ".repeat(6_000), 3, true), 2),
      createMessageEntry(createAssistant("latest", createUsage(10), 4), 3),
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
      createMessageEntry(createAssistant("ok", createUsage(2), 2), 1),
      userEntry("早上好", 2),
      createMessageEntry(createAssistant("ok", createUsage(2), 4), 3),
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
        createMessageEntry(createAssistant("hello", createUsage(2), 2), 1),
        createProjectedEntry(entryType, 2, "x".repeat(4_000)),
        createMessageEntry(createAssistant("ok", createUsage(2), 4), 3),
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
      createMessageEntry(createAssistant("ok", createUsage(2), 2), 1),
      userEntry("second", 2),
      createMessageEntry(createAssistant("ok", createUsage(2), 4), 3),
      userEntry("latest", 4),
      createMessageEntry(createAssistant("done", createUsage(170_000), 6), 5),
    ];

    const result = prepare(entries, {
      enabled: true,
      reserveTokens: 16_384,
      keepRecentTokens: 20_000,
    });

    expect(result.firstKeptEntryId).toBe("entry-4");
    expect(result.messagesToSummarize.length).toBeGreaterThan(0);
  });

  it("keeps reset-filtered tool rows out of later compaction input", () => {
    const entries: SessionTreeEntry[] = [
      userEntry("discarded", 0),
      userEntry("kept question", 1),
      createMessageEntry(
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          content: [{ type: "text", text: "hidden tool result" }],
          isError: false,
          timestamp: 3,
        },
        2,
      ),
      createMessageEntry(createAssistant("kept answer", createUsage(2), 4), 3),
      resetEntry(4, "entry-1"),
      userEntry("post reset", 5),
      createMessageEntry(createAssistant("new answer", createUsage(2), 7), 6),
    ];

    const result = prepare(entries);

    expect(JSON.stringify(result.messagesToSummarize)).not.toContain("hidden tool result");
    expect(JSON.stringify(result.turnPrefixMessages)).not.toContain("hidden tool result");
    expect(["entry-5", "entry-6"]).toContain(result.firstKeptEntryId);
  });

  it("retains only occurrence-paired reset tool results in compaction input", () => {
    const assistantToolCall = (timestamp: number): AssistantMessage => ({
      ...createAssistant("", createUsage(2), timestamp),
      content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
      stopReason: "toolUse",
    });
    const toolResult = (timestamp: number, text: string): AgentMessage => ({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text }],
      isError: false,
      timestamp,
    });
    const entries: SessionTreeEntry[] = [
      userEntry("discarded", 0),
      userEntry("kept", 1),
      createMessageEntry(assistantToolCall(3), 2),
      createMessageEntry(toolResult(4, "first result"), 3),
      createMessageEntry(assistantToolCall(5), 4),
      createMessageEntry(toolResult(6, "second result"), 5),
      createMessageEntry(toolResult(7, "orphan result"), 6),
      resetEntry(7, "entry-1"),
      userEntry("post reset", 8),
      createMessageEntry(createAssistant("new answer", createUsage(2), 10), 9),
    ];

    const result = prepare(entries);

    const summarized = JSON.stringify(result.messagesToSummarize);
    expect(summarized).toContain("first result");
    expect(summarized).toContain("second result");
    expect(summarized).not.toContain("orphan result");
  });

  it("moves the cut earlier when a reset kept-tail prelude consumes the compaction budget", () => {
    const largePrelude = "kept context ".repeat(4_000);
    const postResetEntries: SessionTreeEntry[] = [
      userEntry("post one ".repeat(500), 3),
      createMessageEntry(createAssistant("answer one ".repeat(500), createUsage(2), 5), 4),
      userEntry("post two ".repeat(500), 5),
      createMessageEntry(createAssistant("answer two ".repeat(500), createUsage(2), 7), 6),
    ];
    const buildEntries = (firstKeptEntryId?: string): SessionTreeEntry[] => [
      userEntry(largePrelude, 0),
      resetEntry(1, firstKeptEntryId),
      ...postResetEntries.map((entry, index) =>
        Object.assign({}, entry, {
          id: `entry-${index + 2}`,
          parentId: `entry-${index + 1}`,
        }),
      ),
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
  const settings = {
    enabled: true,
    reserveTokens: 0,
    keepRecentTokens: 1,
  };
  it.each([
    { name: "ordinary", fromHook: false, compactable: true },
    { name: "safeguard", fromHook: true, compactable: false },
  ])("handles a $name trailing compaction boundary", ({ fromHook, compactable }) => {
    const largeContent = "x".repeat(200_000);
    const entries: SessionTreeEntry[] = [
      userEntry("original request", 0),
      {
        type: "compaction",
        id: "compaction-1",
        parentId: "entry-0",
        timestamp: new Date(2).toISOString(),
        summary: "earlier summary",
        firstKeptEntryId: "entry-0",
        tokensBefore: 200_000,
      },
      userEntry(largeContent, 2),
      createMessageEntry(createAssistant(largeContent, createUsage(10), 4), 3),
      userEntry(largeContent, 4),
      createMessageEntry(createAssistant("recent reply tail", createUsage(10), 6), 5),
      {
        type: "compaction",
        id: "compaction-2",
        parentId: "entry-5",
        timestamp: new Date(7).toISOString(),
        summary: "later summary",
        firstKeptEntryId: "entry-2",
        tokensBefore: 200_000,
        fromHook,
      },
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
        {
          type: "compaction",
          id: "compaction-3",
          parentId: "compaction-2",
          timestamp: new Date(8).toISOString(),
          summary: "final summary",
          firstKeptEntryId: result.value.firstKeptEntryId,
          tokensBefore: result.value.tokensBefore,
        },
      ],
      settings,
    );

    expect(nextResult.ok).toBe(true);
    expect(nextResult.ok ? nextResult.value : undefined).toBeUndefined();
  });

  it("ignores missing fields in persisted compaction details", () => {
    const largeContent = "x".repeat(200_000);
    const entries: SessionTreeEntry[] = [
      userEntry("original request", 0),
      {
        type: "compaction",
        id: "entry-1",
        parentId: "entry-0",
        timestamp: new Date(2).toISOString(),
        summary: "earlier summary",
        firstKeptEntryId: "entry-0",
        tokensBefore: 200_000,
        details: { readFiles: ["src/read.ts"] },
      },
      userEntry(largeContent, 2),
      createMessageEntry(createAssistant(largeContent, createUsage(10), 4), 3),
      userEntry("recent tail", 4),
    ];

    const result = prepare(entries, settings);

    expect(result.previousSummaryDetails).toBeUndefined();
    expect([...result.fileOps.read]).toEqual([]);
    expect([...result.fileOps.written]).toEqual([]);
    expect([...result.fileOps.edited]).toEqual([]);
  });
});

describe("generateSummary progress updates", () => {
  it("asks to keep completed checks distinct from unresolved blockers", async () => {
    const completeSimple = vi.fn(async () => createAssistant("summary", createUsage(1), 4));
    const result = await summarize(
      [
        { role: "user", content: "Check whether the release is approved.", timestamp: 1 },
        {
          ...createAssistant("", createUsage(0), 2),
          content: [{ type: "toolCall", id: "check", name: "verify", arguments: {} }],
          stopReason: "toolUse",
        },
        {
          role: "toolResult",
          toolCallId: "check",
          toolName: "verify",
          content: [{ type: "text", text: "Verification FAILED: missing release approval." }],
          isError: true,
          timestamp: 3,
        },
      ],
      createSummaryModel(),
      undefined,
      { previous: "Release approval check: pending.", runtime: { completeSimple } },
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
    const model = createSummaryModel();
    let consumed = false;
    const streamFn = vi.fn<StreamFn>(() => ({
      [Symbol.asyncIterator]() {
        return {
          async next() {
            consumed = true;
            return { done: true as const, value: undefined };
          },
        };
      },
      async result() {
        if (!consumed) {
          throw new Error("stream result read before iteration");
        }
        return createAssistant("summary", createUsage(1), 1);
      },
    }));

    await summarize([{ role: "user", content: "hello", timestamp: 1 }], model, streamFn);

    expect(consumed).toBe(true);
  });

  it("maps explicit Fable off to low effort for compaction", async () => {
    const model: Model = {
      id: "production-fable",
      name: "Production Fable",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      params: { canonicalModelId: "claude-fable-5" },
    };
    const summaryMessage: AssistantMessage = {
      ...createAssistant("summary", createUsage(0), 1),
      api: model.api,
      provider: model.provider,
      model: model.id,
    };
    const streamFn = vi.fn<StreamFn>((_model, context, options) => {
      expect(options?.reasoning).toBe("low");
      expect(context.systemPrompt).toContain("user and an AI assistant");
      expect(context.systemPrompt).not.toContain("AI coding assistant");
      return responseStream(summaryMessage);
    });

    const result = await summarize(
      [{ role: "user", content: "hello", timestamp: 1 }],
      model,
      streamFn,
      { thinking: "off" },
    );

    expect(result).toEqual({ ok: true, value: "summary" });
    expect(streamFn).toHaveBeenCalledOnce();
  });

  it("rejects whitespace-only compaction output", async () => {
    const content: AssistantMessage["content"] = [{ type: "text", text: " \n\t " }];
    const model = createSummaryModel(true);
    const streamFn = vi.fn<StreamFn>(() =>
      responseStream({ ...createAssistant("", createUsage(1), 1), content, model: model.id }),
    );

    const result = await summarize(
      [{ role: "user", content: "hello", timestamp: 1 }],
      model,
      streamFn,
      { thinking: "low" },
    );

    assert(!result.ok);
    expect(result.error).toBeInstanceOf(InvalidSummaryOutputError);
    expect(result.error).toMatchObject({
      name: "CompactionError",
      code: "summarization_failed",
      message: "Summarization failed: model returned no summary text",
    });
  });

  it("identifies a length-stopped reasoning-only summary as an exhausted output budget", async () => {
    const model = createSummaryModel(true);
    const streamFn = vi.fn<StreamFn>(() =>
      responseStream({
        ...createAssistant("", createUsage(800), 1),
        content: [{ type: "thinking", thinking: "internal summary reasoning" }],
        stopReason: "length",
      }),
    );

    const result = await summarize(
      [{ role: "user", content: "hello", timestamp: 1 }],
      model,
      streamFn,
      { thinking: "high" },
    );

    expect(streamFn).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ error: expect.any(SummaryOutputBudgetError) });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "summarization_failed",
        message: expect.stringContaining("output budget (800 tokens) was exhausted"),
      },
    });
  });
});

describe("split-turn compaction", () => {
  const operatorFocus = "Preserve API decisions.";
  const runtimeContext: AgentMessage = {
    role: "custom",
    customType: "openclaw.runtime-context",
    content: "PRIVATE_RUNTIME_CONTEXT",
    display: false,
    details: { source: "openclaw-runtime-context", runtimeContextCarrier: true },
    timestamp: 1,
  };
  it.each([
    { name: "prefix-only", history: false, prefix: true, budgets: [500] },
    {
      name: "caller-owned instructions",
      history: true,
      prefix: true,
      budgets: [800, 500],
      focus: `<policy>${"preserve generated policy ".repeat(200)}</policy>`,
    },
  ])(
    "forwards focus and serializes $name summaries",
    async ({ history, prefix, budgets, focus = operatorFocus }) => {
      const model = createSummaryModel();
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
      const result = await compact(
        {
          firstKeptEntryId: "kept-entry",
          messagesToSummarize: history
            ? [{ role: "user", content: "history", timestamp: 1 }, runtimeContext]
            : [],
          turnPrefixMessages: prefix
            ? [{ role: "user", content: "prefix", timestamp: 2 }, runtimeContext]
            : [],
          isSplitTurn: prefix,
          tokensBefore: 100,
          fileOps: createFileOps(),
          settings: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 100 },
        },
        model,
        undefined,
        undefined,
        focus,
        undefined,
        undefined,
        streamFn,
        { completeSimple: vi.fn(), internalUsageSink: usageSink },
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
      if (prefix) {
        expect(prompts.at(-1)).toContain("## Original Request");
        expect(prompts.at(-1)).not.toContain("## Goal");
      }
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
      messagesToSummarize: [{ role: "user", content: "history", timestamp: 1 }],
      turnPrefixMessages: [{ role: "user", content: sourceAsk, timestamp: 2 }],
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
