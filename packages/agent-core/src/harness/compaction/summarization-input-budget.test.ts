import type { Model, StreamFn } from "@openclaw/llm-core";
import {
  CHARS_PER_TOKEN_ESTIMATE,
  estimateStringChars,
} from "@openclaw/normalization-core/cjk-chars";
import { describe, expect, it, vi } from "vitest";
import { createZeroUsage } from "../../../../ai/src/usage.test-support.js";
import type { AgentMessage } from "../../types.js";
import { convertToLlm } from "../messages.js";
import { SummaryOutputBudgetError } from "../types.js";
import { createCompactionModel } from "./compaction.test-support.js";
import {
  assistant,
  responseStream,
  summarize as requestSummary,
  toolCall,
  toolResult,
  user,
} from "./shard-fixtures.test-support.js";
import {
  MAX_SUMMARY_INPUT_CHARS,
  serializeConversation,
  serializeConversationWithinBudget,
} from "./utils.js";

function createModel(contextWindow: number, maxTokens = 32_000): Model {
  return createCompactionModel({ contextWindow, maxTokens });
}

/**
 * Records the summary prompt the provider receives and answers with a fixed
 * summary, or with a provider context-overflow error while `overflowAbove`
 * says the prompt is too long.
 */
function createCapturingStream(overflowAbove?: (prompt: string) => boolean): {
  streamFn: StreamFn;
  prompts: string[];
} {
  const prompts: string[] = [];
  const streamFn: StreamFn = (model, context) => {
    const block = context.messages[0]?.content;
    const prompt = Array.isArray(block) && block[0]?.type === "text" ? block[0].text : "";
    prompts.push(prompt);
    const overflow = overflowAbove?.(prompt) === true;
    return responseStream(
      assistant(overflow ? [] : "summary", {
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: { ...createZeroUsage(), input: 1, output: 1, totalTokens: 2 },
        stopReason: overflow ? "error" : "stop",
        ...(overflow ? { errorMessage: "prompt is too long: 40000 tokens > 32768 maximum" } : {}),
      }),
    );
  };
  return { streamFn, prompts };
}

function toolCallMessage(
  calls: Array<{ id: string; name: string; cmd: string }>,
  stopReason: "toolUse" | "aborted" = "toolUse",
): AgentMessage {
  return assistant(
    calls.map(({ id, name, cmd }) => toolCall(name, { cmd }, id)),
    { model: "summary-model", stopReason },
  );
}

function toolResultMessage(toolCallId: string, toolName: string, text: string): AgentMessage {
  return toolResult(text, { toolCallId, toolName });
}

/** A tool-heavy session; 1,250 turns serialize to about 5.5M characters (over 1M tokens). */
function createLongSession(turns: number): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (let turn = 0; turn < turns; turn += 1) {
    messages.push(user(`ask-${turn} ${"context ".repeat(100)}`, turn));
    messages.push(
      assistant(
        [
          { type: "text", text: `reply-${turn} ${"reasoning ".repeat(150)}` },
          toolCall("exec", { cmd: `run ${turn}` }, `call-${turn}`),
        ],
        { model: "summary-model", stopReason: "toolUse", timestamp: turn },
      ),
    );
    messages.push(
      toolResult(`result-${turn} ${"output ".repeat(1_500)}`, {
        toolCallId: `call-${turn}`,
        toolName: "exec",
        timestamp: turn,
      }),
    );
  }
  return messages;
}

function conversationOf(prompt: string): string {
  const match = /^<conversation>\n([\s\S]*)\n<\/conversation>/u.exec(prompt);
  if (!match?.[1]) {
    throw new Error("summary prompt has no conversation block");
  }
  return match[1];
}

function bounded(messages: AgentMessage[], budget = MAX_SUMMARY_INPUT_CHARS) {
  const result = serializeConversationWithinBudget(convertToLlm(messages), budget);
  expect(estimateStringChars(result.text)).toBeLessThanOrEqual(budget);
  return result;
}

async function summarize(messages: AgentMessage[], model: Model, previousSummary?: string) {
  const { streamFn, prompts } = createCapturingStream();
  const result = await requestSummary(messages, model, {
    reserveTokens: 16_384,
    previousSummary,
    streamFn,
  });
  expect(result).toEqual({ ok: true, value: "summary" });
  expect(prompts).toHaveLength(1);
  return prompts[0] ?? "";
}

describe("summary request input budget", () => {
  it("sends a small history unchanged", async () => {
    const messages = createLongSession(3);
    const prompt = await summarize(messages, createModel(1_000_000));

    expect(conversationOf(prompt)).toBe(serializeConversation(convertToLlm(messages)));
    expect(prompt).not.toContain("entries omitted ...]");
  });

  it("keeps one summary request bounded when the history fills a 1M-token window", async () => {
    const messages = createLongSession(1_250);
    expect(serializeConversation(convertToLlm(messages)).length).toBeGreaterThan(5_000_000);

    const prompt = await summarize(messages, createModel(1_000_000), "PREVIOUS-SUMMARY-FACT");
    const conversation = conversationOf(prompt);

    expect(estimateStringChars(conversation)).toBeLessThanOrEqual(MAX_SUMMARY_INPUT_CHARS);
    expect(conversation).toContain(`[User]: ask-1249 ${"context ".repeat(100)}`);
    const newestResult = serializeConversation(convertToLlm(messages.slice(-1)));
    expect(
      conversation.endsWith(
        `[Tool result of exec(cmd="run 1249")]${newestResult.slice("[Tool result]".length)}`,
      ),
    ).toBe(true);
    expect(conversation).toContain("[User]: ask-0 ");
    const gaps = [...conversation.matchAll(/\[\.\.\. (\d+) entr(?:y|ies) omitted \.\.\.\]/gu)];
    expect(gaps.length).toBeGreaterThan(1);
    const kept = conversation
      .split("\n\n")
      .filter((part) => /^\[(User|Assistant|Assistant tool calls|Tool result)/u.test(part));
    const omitted = gaps.reduce((sum, gap) => sum + Number(gap[1]), 0);
    expect(kept.length + omitted).toBe(1_250 * 4);
    expect(conversation).not.toContain("[Tool result]:");
    const results = [
      ...conversation.matchAll(/\[Tool result of exec\(cmd="run (\d+)"\)\]: result-(\d+) /gu),
    ];
    expect(results.length).toBeGreaterThan(3);
    expect(results.filter((result) => result[1] !== result[2])).toEqual([]);
    expect(results).toHaveLength([...conversation.matchAll(/ result-\d+ /gu)].length);
    expect(prompt).toContain("Do not guess what they said.");
    expect(prompt).toContain("<previous-summary>\nPREVIOUS-SUMMARY-FACT\n</previous-summary>");
  });

  it("keeps the whole request inside a small summarizer window", async () => {
    const model = createModel(32_768, 8_192);
    const prompt = await summarize(createLongSession(200), model);
    const outputTokens = Math.min(Math.floor(0.8 * 16_384), 8_192);

    const promptTokens = estimateStringChars(prompt) / CHARS_PER_TOKEN_ESTIMATE;
    expect(promptTokens + outputTokens).toBeLessThan(32_768);
    expect(prompt).toContain("entries omitted ...]");
  });

  it.each([
    { name: "a long history", messages: createLongSession(5) },
    {
      name: "a short history",
      messages: [user("hello")],
    },
  ])("fails without a model call when the window cannot hold $name", async ({ messages }) => {
    const { streamFn, prompts } = createCapturingStream();
    const result = await requestSummary(messages, createModel(4_096, 4_096), {
      reserveTokens: 3_000,
      previousSummary: "漢".repeat(4_000),
      streamFn,
    });

    expect(prompts).toHaveLength(0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(SummaryOutputBudgetError);
      expect(result.error.message).toContain("agents.defaults.compaction.model");
    }
  });

  it("keeps both ends of a newest entry that alone exceeds the newest-entries share", () => {
    const result = bounded([
      user(`older ${"a".repeat(300_000)}`),
      user(`NEWEST-HEAD ${"b".repeat(300_000)} NEWEST-TAIL`, 2),
    ]);
    expect(result.text).toContain("[User]: NEWEST-HEAD b");
    expect(result.text.endsWith("b NEWEST-TAIL")).toBe(true);
    expect(result.text).toMatch(/\[\.\.\. \d+ characters omitted \.\.\.\]/u);
    expect(result).toMatchObject({ trimmedEntries: 2, omittedEntries: 0 });
  });

  it("keeps an excerpt of a huge newest entry that mixes CJK and ASCII text", () => {
    const result = bounded([user(`${"𠀀".repeat(500)}${"a".repeat(1_000_000)} END`)]);
    expect(result.text.startsWith("[User]: 𠀀")).toBe(true);
    expect(result.text.endsWith("a END")).toBe(true);
    expect(result.omittedEntries).toBe(0);
  });

  it("counts CJK text by its token weight, not its length", () => {
    const result = bounded(
      Array.from({ length: 400 }, (_, i) => user(`${i} ${"漢字".repeat(1_000)}`, i)),
    );
    expect(result.omittedEntries).toBeGreaterThan(0);
    expect(result.text.length).toBeLessThan(MAX_SUMMARY_INPUT_CHARS / 2);
  });

  it("names the call of every sampled tool result, even after the image-omission note", () => {
    const messages: AgentMessage[] = [];
    for (let index = 0; index < 100; index += 1) {
      messages.push(toolCallMessage([{ id: `c-${index}`, name: "exec", cmd: `command-${index}` }]));
      // The ninth image omission adds a standalone note before its result.
      const image = index < 8 || index === 50;
      messages.push({
        role: "toolResult",
        toolCallId: `c-${index}`,
        toolName: "exec",
        content: [
          ...(image ? [{ type: "image" as const, data: "AA==", mimeType: "image/png" }] : []),
          { type: "text", text: `RESULT-${index} ${"x".repeat(1_900)}` },
        ],
        isError: false,
        timestamp: index,
      });
    }

    for (let budget = 4_000; budget <= 60_000; budget += 1_000) {
      const { text } = bounded(messages, budget);
      const named = [
        ...text.matchAll(/exec\(cmd="command-(\d+)"\)\]: (?:\[.*\]\n)?RESULT-(\d+) /gu),
      ];
      expect(
        named.filter((result) => result[1] !== result[2]),
        `budget ${budget}`,
      ).toEqual([]);
      expect(named, `budget ${budget}`).toHaveLength([...text.matchAll(/RESULT-\d+ /gu)].length);
    }
  });

  it.each([6_000, 9_000, 20_000])(
    "keeps the newest result and names its call when one argument fills a %i-character budget",
    (budget) => {
      const messages: AgentMessage[] = [
        user("Write the report."),
        toolCallMessage([{ id: "w-1", name: "write", cmd: "x".repeat(30_000) }]),
        toolResultMessage("w-1", "write", "WRITE-FAILED: disk full"),
      ];

      const { text } = bounded(messages, budget);

      expect(text).toMatch(/\[Tool result of write\(cmd="x+\.\.\.\)\]: WRITE-FAILED: disk full$/u);
    },
  );

  it("names the call of each result from a trimmed multi-call batch", () => {
    const names = Array.from({ length: 24 }, (_, index) => `tool${index}`);
    const messages: AgentMessage[] = [
      toolCallMessage(names.map((name) => ({ id: name, name, cmd: "y".repeat(10_000) }))),
      ...names.map((name) => toolResultMessage(name, name, `R-${name}`)),
      user(`NEWEST ${"z".repeat(200_000)}`, 9),
    ];

    const { text } = bounded(messages);

    for (const name of names) {
      expect(text).toMatch(
        new RegExp(`\\[Tool result of ${name}\\(cmd="y+\\.\\.\\.\\)\\]: R-${name}\\b`, "u"),
      );
    }
  });

  it("names the call of a result that follows an intervening user message", () => {
    const messages: AgentMessage[] = [
      ...createLongSession(60),
      toolCallMessage([{ id: "report", name: "write_report", cmd: "r".repeat(40_000) }]),
      user("Any update?", 2),
      toolResultMessage("report", "write_report", "WRITE_FAILED: quota"),
    ];

    const { text } = bounded(messages);

    expect(text).toContain("entries omitted ...]");
    expect(text).toMatch(/\[Tool result of write_report\(cmd="r+\.\.\.\)\]: WRITE_FAILED: quota$/u);
  });

  it("rejects an undersized sample but sends a short history unchanged", async () => {
    const { streamFn, prompts } = createCapturingStream();
    const model = createModel(4_096, 4_096);
    const options = {
      reserveTokens: 2_500,
      streamFn,
    };
    const result = await requestSummary([user("Rename the queue.")], model, options);

    expect(result).toEqual({ ok: true, value: "summary" });
    expect(prompts).toHaveLength(1);
    expect(conversationOf(prompts[0] ?? "")).toBe("[User]: Rename the queue.");

    const sampled = await requestSummary(
      [user("Keep this decision. ".repeat(1_000))],
      model,
      options,
    );

    expect(sampled.ok).toBe(false);
    if (!sampled.ok) {
      expect(sampled.error).toBeInstanceOf(SummaryOutputBudgetError);
    }
    expect(prompts).toHaveLength(1);
  });

  it.each([
    // 0.8 × 8,192 visible output plus each level's thinking budget.
    { api: "anthropic-messages", id: "claude-legacy-thinking", level: "high", window: 32_768 },
    // The standalone Anthropic provider keeps the full `max` budget.
    { api: "anthropic-messages", id: "claude-legacy-thinking", level: "max", window: 65_536 },
    { api: "bedrock-converse-stream", id: "claude-legacy-thinking", level: "high", window: 32_768 },
    // Bedrock Mantle adds a budget even for adaptive models.
    { api: "anthropic-messages", id: "claude-sonnet-4-6", level: "high", window: 32_768 },
  ] as const)(
    "reserves the $level thinking budget $api may add for $id",
    async ({ api, id, level, window }) => {
      const thinking = level === "max" ? 32_768 : 16_384;
      const { streamFn, prompts } = createCapturingStream();
      const model: Model = {
        ...createModel(window, 64_000),
        id,
        api,
        provider: "anthropic",
        reasoning: true,
      };
      const result = await requestSummary(createLongSession(80), model, {
        reserveTokens: 8_192,
        thinkingLevel: level,
        streamFn,
      });

      expect(result).toEqual({ ok: true, value: "summary" });
      const completionTokens = Math.floor(0.8 * 8_192) + thinking;
      const promptTokens = estimateStringChars(prompts[0] ?? "") / CHARS_PER_TOKEN_ESTIMATE;
      expect(promptTokens + completionTokens).toBeLessThan(window);
    },
  );

  it("does not reserve a thinking budget when maxTokens is the total output limit", async () => {
    const { streamFn, prompts } = createCapturingStream();
    const model: Model = {
      ...createModel(16_384, 16_384),
      api: "openai-completions",
      provider: "openai",
      reasoning: true,
    };
    const result = await requestSummary([user("Rename the queue.")], model, {
      reserveTokens: 4_096,
      thinkingLevel: "high",
      streamFn,
    });

    expect(result).toEqual({ ok: true, value: "summary" });
    expect(conversationOf(prompts[0] ?? "")).toBe("[User]: Rename the queue.");
  });

  it("never labels a result with a call an earlier turn left unanswered", () => {
    const messages: AgentMessage[] = [
      toolCallMessage([{ id: "0", name: "exec", cmd: "delete A" }], "aborted"),
      toolCallMessage([{ id: "0", name: "exec", cmd: "write B" }]),
      toolResultMessage("0", "exec", "done"),
      user(`NEWEST ${"z".repeat(200_000)}`, 9),
    ];

    const { text } = bounded(messages);

    expect(text).toContain('[Tool result of exec(cmd="write B")]: done');
  });

  it("names each result by the call occurrence it answers when call IDs repeat", () => {
    const messages: AgentMessage[] = [
      toolCallMessage([
        { id: "exec_0", name: "exec", cmd: "first" },
        { id: "exec_0", name: "exec", cmd: "second" },
      ]),
      toolResultMessage("exec_0", "exec", "OUT-FIRST"),
      toolResultMessage("exec_0", "exec", "OUT-SECOND"),
      user(`NEWEST ${"z".repeat(200_000)}`, 9),
    ];

    const { text } = bounded(messages);

    expect(text).toContain('[Tool result of exec(cmd="first")]: OUT-FIRST');
    expect(text).toContain('[Tool result of exec(cmd="second")]: OUT-SECOND');
  });

  it("keeps every user decision from a long tool-heavy history", () => {
    const messages = createLongSession(400);
    const decisions = [40, 133, 217, 301].map((turn) => ({
      turn,
      text: `DECISION-${turn}: use advisory locks, not Redis`,
    }));
    for (const { turn, text } of decisions) {
      messages[turn * 3] = user(text, turn);
    }
    for (let turn = 0; turn < 400; turn += 1) {
      if (!decisions.some((decision) => decision.turn === turn)) {
        messages[turn * 3] = user(`ask-${turn}`, turn);
      }
    }

    const { text } = bounded(messages);
    for (const { text: decision } of decisions) {
      expect(text).toContain(`[User]: ${decision}`);
    }
    for (let turn = 0; turn < 400; turn += 1) {
      expect(text).toMatch(new RegExp(`\\[User\\]: (?:ask|DECISION)-${turn}\\b`, "u"));
    }
  });

  it("spreads user messages across the history when they do not all fit", () => {
    const { text } = bounded(
      Array.from({ length: 2_000 }, (_, i) => user(`USER-${i} ${"note ".repeat(80)}`, i)),
    );
    const kept = [...text.matchAll(/\[User\]: USER-(\d+) /gu)].map((match) => Number(match[1]));

    // Each tenth of the history keeps some of its user messages.
    for (let tenth = 0; tenth < 10; tenth += 1) {
      expect(
        kept.some((index) => Math.floor(index / 200) === tenth),
        `tenth ${tenth}`,
      ).toBe(true);
    }
  });

  it("shrinks the sample when a provider plugin raised the output limit past the window", async () => {
    // A plugin output floor makes the first, correctly sized request overflow.
    const { streamFn, prompts } = createCapturingStream((prompt) => prompt.length > 60_000);
    const result = await requestSummary(createLongSession(200), createModel(200_000, 64_000), {
      reserveTokens: 16_384,
      streamFn,
    });

    expect(result).toEqual({ ok: true, value: "summary" });
    expect(prompts.length).toBeGreaterThan(1);
    expect(prompts.at(-1)?.length).toBeLessThanOrEqual(60_000);
    expect(prompts.at(-1)).toContain("entries omitted ...]");
  });

  it("stops with a budget error when the provider keeps rejecting the request as too long", async () => {
    const { streamFn, prompts } = createCapturingStream(() => true);
    const result = await requestSummary(createLongSession(200), createModel(200_000, 64_000), {
      reserveTokens: 16_384,
      streamFn,
    });

    expect(prompts).toHaveLength(3);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(SummaryOutputBudgetError);
    }
  });

  it("does not retry an overflow after the caller cancels", async () => {
    const controller = new AbortController();
    const { streamFn: overflowing, prompts } = createCapturingStream(() => true);
    const streamFn: StreamFn = (model, context, options) => {
      controller.abort();
      return overflowing(model, context, options);
    };
    const usage: unknown[] = [];
    const result = await requestSummary(createLongSession(200), createModel(200_000, 64_000), {
      reserveTokens: 16_384,
      signal: controller.signal,
      streamFn,
      runtime: {
        completeSimple: vi.fn(),
        internalUsageSink: (entry) => {
          usage.push(entry);
        },
      },
    });

    expect(prompts).toHaveLength(1);
    expect(usage).toHaveLength(1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("aborted");
    }
  });
});
