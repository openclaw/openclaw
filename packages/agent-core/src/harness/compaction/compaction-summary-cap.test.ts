import { assert, expect, it, vi } from "vitest";
import type { AssistantMessage, Model, StreamFn } from "../../llm.js";
import { InvalidSummaryOutputError, SummaryOutputBudgetError } from "../types.js";
import { createCompactionModel, createContextUsage as usage } from "./compaction.test-support.js";
import {
  assistant,
  captureStream,
  compactWith,
  contains,
  decoratedResponse,
  excludes,
  makePreparation,
  modelReply,
  responseStream,
  summarize,
  text,
  toolCall,
  toolResult,
  user,
} from "./shard-fixtures.test-support.js";
import { createFileOps } from "./utils.js";

it("preserves split-turn context, metadata and UTF-16 boundaries under summary caps", async () => {
  const cap = 16_000;
  const marker = "\n\n[Compaction summary truncated to fit budget]";
  const heading = "\n\n---\n\n**Turn Context (split turn):**\n\n";
  let prefix = "prefix summary";
  const capture = captureStream(() => assistant(prefix, { usage: usage(0) }));
  const fileOps = createFileOps();
  fileOps.read.add("src/read.ts");
  fileOps.edited.add("src/write.ts");
  const files =
    "\n\n<read-files>\nsrc/read.ts\n</read-files>\n\n<modified-files>\nsrc/write.ts\n</modified-files>";
  const nearCap = `${"p".repeat(cap - files.length)}${files}`;
  const run = async (
    previousSummary = nearCap,
    budget: Parameters<typeof makePreparation>[0] = {},
  ) => {
    const result = await compactWith(
      makePreparation({
        ...budget,
        previousSummary,
        fileOps,
        previousSummaryDetails: { readFiles: ["src/read.ts"], modifiedFiles: ["src/write.ts"] },
        turnPrefixMessages: [
          assistant(
            [
              { type: "thinking", thinking: "PRIVATE_PREFIX_REASONING" },
              text("visible prefix"),
              toolCall("read", { path: "prefix.ts" }, "prefix-call"),
            ],
            { usage: usage(1) },
          ),
        ],
      }),
      createCompactionModel(),
      { streamFn: capture.streamFn },
    );
    assert(result.ok);
    return result.value.summary;
  };
  expect(await run(`previous summary${files}`)).toBe(
    `previous summary${heading}prefix summary${files}`,
  );
  contains(
    capture.prompts[0] ?? "",
    "[Assistant]: visible prefix",
    '[Assistant tool calls]: read(path="prefix.ts")',
  );
  excludes(capture.prompts[0] ?? "", "PRIVATE_PREFIX_REASONING");
  const persisted = await run();
  expect(persisted.length).toBeLessThanOrEqual(cap);
  contains(persisted, marker, "prefix summary");
  expect(persisted.endsWith(files)).toBe(true);
  const latestBudget = cap - marker.length - files.length - Math.floor(cap / 2);
  prefix = `${"x".repeat(latestBudget - heading.length - 1)}🚀tail`;
  const oversized = await run();
  expect(oversized.length).toBeLessThanOrEqual(cap);
  expect(oversized).toMatch(/^p{100}/);
  contains(oversized, heading, "x".repeat(100), marker);
  excludes(oversized, "🚀");
  expect(oversized).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  expect(oversized).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  expect(oversized.endsWith(files)).toBe(true);
  expect(capture.streamFn).toHaveBeenCalledTimes(3);
  fileOps.read = new Set([`src/${"r".repeat(830)}.ts`]);
  fileOps.edited = new Set([`src/${"w".repeat(820)}.ts`]);
  prefix = "The split turn still needs its archive result.";
  const budgeted = await run(nearCap, {
    summaryTokenBudget: 1_000,
    latestUnresolvedUserRequest: "Current request details. ".repeat(32),
  });
  expect(budgeted.length).toBeLessThanOrEqual(4_000);
  contains(budgeted, prefix, heading, ...fileOps.read, ...fileOps.edited);
});

it.each([
  [80_000, false, [64_000]],
  [20_000, false, [16_000]],
  [16_384, false, [13_107]],
  [80_000, true, [64_000, 40_000]],
] as const)("preserves caller reserve %i (split: %s)", async (reserveTokens, split, expected) => {
  const model = {
    ...createCompactionModel({ contextWindow: 1_000_000, maxTokens: 128_000 }),
    id: "budget-model",
    name: "Budget Model",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    params: {},
  };
  let count = 0;
  const capture = captureStream(() => modelReply(model, split ? `summary-${++count}` : "summary"));
  const options = { streamFn: capture.streamFn };
  const result = split
    ? await compactWith(
        makePreparation({
          messagesToSummarize: [user("history")],
          turnPrefixMessages: [user("prefix", 2)],
          settings: { enabled: true, reserveTokens, keepRecentTokens: 100 },
        }),
        model,
        options,
      )
    : await summarize([user("hello")], model, { reserveTokens, ...options });
  expect(result.ok).toBe(true);
  if (!split) {
    expect(result).toEqual({ ok: true, value: "summary" });
  }
  expect(capture.outputBudgets).toEqual(expected);
});

it("distinguishes completed checks from unresolved blockers in update prompts", async () => {
  const completeSimple = vi.fn(async () => assistant("summary", { usage: usage(1), timestamp: 4 }));
  const result = await summarize(
    [
      user("Check whether the release is approved."),
      assistant([toolCall("verify", {}, "check")], {
        usage: usage(0),
        timestamp: 2,
        stopReason: "toolUse",
      }),
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
  contains(
    JSON.stringify(completeSimple.mock.calls),
    "Release approval check: pending.",
    "Verification FAILED: missing release approval.",
    "Record checks that ran and their results as completed",
    "keep unresolved blockers separate",
  );
});

it("consumes a decorated summary stream before reading its result", async () => {
  const { streamFn, consumed } = decoratedResponse(assistant("summary", { usage: usage(1) }));
  await summarize([user("hello")], createCompactionModel(), { streamFn });
  expect(consumed()).toBe(true);
});

it("maps explicit Fable off to low effort with the general assistant prompt", async () => {
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
  const streamFn = vi.fn<StreamFn>((_model, context, options) => {
    expect(options?.reasoning).toBe("low");
    contains(context.systemPrompt ?? "", "user and an AI assistant");
    excludes(context.systemPrompt ?? "", "AI coding assistant");
    return responseStream(modelReply(model, "summary", { usage: usage(0) }));
  });
  expect(await summarize([user("hello")], model, { streamFn, thinkingLevel: "off" })).toEqual({
    ok: true,
    value: "summary",
  });
  expect(streamFn).toHaveBeenCalledOnce();
});

it.each(["stop", "length"] as const)("classifies empty output after %s", async (stopReason) => {
  const exhausted = stopReason === "length";
  const content: AssistantMessage["content"] = exhausted
    ? [{ type: "thinking", thinking: "internal summary reasoning" }]
    : [text(" \n\t ")];
  const model = createCompactionModel({ reasoning: true });
  const capture = captureStream(() =>
    modelReply(model, content, { usage: usage(exhausted ? 800 : 1), stopReason }),
  );
  const result = await summarize([user("hello")], model, {
    streamFn: capture.streamFn,
    thinkingLevel: exhausted ? "high" : "low",
  });
  assert(!result.ok);
  expect(capture.streamFn).toHaveBeenCalledOnce();
  expect(result.error).toBeInstanceOf(
    exhausted ? SummaryOutputBudgetError : InvalidSummaryOutputError,
  );
  expect(result.error).toMatchObject({
    name: "CompactionError",
    code: "summarization_failed",
    message: exhausted
      ? expect.stringContaining("output budget (800 tokens) was exhausted")
      : "Summarization failed: model returned no summary text",
  });
});

it.each([{ kind: "custom", instructions: "Custom format." }, { kind: "turn-prefix" }] as const)(
  "keeps attribution instructions for $kind prompts",
  async (summaryPrompt) => {
    const capture = captureStream(() =>
      assistant("summary", { model: "summary-model", usage: usage(1) }),
    );
    const result = await summarize(
      [user("Alice owns this decision.", 1, { senderId: "alice" })],
      createCompactionModel(),
      { streamFn: capture.streamFn, summaryPrompt },
    );
    expect(result.ok).toBe(true);
    contains(
      capture.readCapture().systemPrompt,
      "Preserve attribution for material facts",
      "A user line without sender={...} is unattributed",
    );
  },
);
