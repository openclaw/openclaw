import type { Model, StreamFn } from "@openclaw/llm-core";
import {
  CHARS_PER_TOKEN_ESTIMATE,
  estimateStringChars,
} from "@openclaw/normalization-core/cjk-chars";
import { describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream } from "../../llm.js";
import type { AgentMessage } from "../../types.js";
import { convertToLlm } from "../messages.js";
import { SummaryOutputBudgetError } from "../types.js";
import { generateSummary } from "./compaction.js";
import {
  MAX_SUMMARY_INPUT_CHARS,
  serializeConversation,
  serializeConversationWithinBudget,
} from "./utils.js";

function createModel(contextWindow: number, maxTokens = 32_000): Model {
  return {
    id: "summary-model",
    name: "Summary Model",
    api: "test-api",
    provider: "test-provider",
    baseUrl: "https://example.test",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  };
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
    const stream = createAssistantMessageEventStream();
    const message = {
      role: "assistant" as const,
      content: overflow ? [] : [{ type: "text" as const, text: "summary" }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      timestamp: 1,
    };
    if (overflow) {
      stream.push({
        type: "error",
        reason: "error",
        error: {
          ...message,
          stopReason: "error",
          errorMessage: "prompt is too long: 40000 tokens > 32768 maximum",
        },
      });
    } else {
      stream.push({ type: "done", reason: "stop", message: { ...message, stopReason: "stop" } });
    }
    stream.end();
    return stream;
  };
  return { streamFn, prompts };
}

function toolCallMessage(
  calls: Array<{ id: string; name: string; cmd: string }>,
  stopReason: "toolUse" | "aborted" = "toolUse",
): AgentMessage {
  return {
    role: "assistant",
    content: calls.map(({ id, name, cmd }) => ({
      type: "toolCall" as const,
      id,
      name,
      arguments: { cmd },
    })),
    api: "test-api",
    provider: "test-provider",
    model: "summary-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 1,
  };
}

function toolResultMessage(toolCallId: string, toolName: string, text: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 1,
  };
}

/** A tool-heavy session; 1,250 turns serialize to about 5.5M characters (over 1M tokens). */
function createLongSession(turns: number): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (let turn = 0; turn < turns; turn += 1) {
    messages.push({
      role: "user",
      content: `ask-${turn} ${"context ".repeat(100)}`,
      timestamp: turn,
    });
    messages.push({
      role: "assistant",
      content: [
        { type: "text", text: `reply-${turn} ${"reasoning ".repeat(150)}` },
        { type: "toolCall", id: `call-${turn}`, name: "exec", arguments: { cmd: `run ${turn}` } },
      ],
      api: "test-api",
      provider: "test-provider",
      model: "summary-model",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: turn,
    });
    messages.push({
      role: "toolResult",
      toolCallId: `call-${turn}`,
      toolName: "exec",
      content: [{ type: "text", text: `result-${turn} ${"output ".repeat(1_500)}` }],
      isError: false,
      timestamp: turn,
    });
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

async function summarize(messages: AgentMessage[], model: Model, previousSummary?: string) {
  const { streamFn, prompts } = createCapturingStream();
  const result = await generateSummary(
    messages,
    model,
    16_384,
    undefined,
    undefined,
    undefined,
    undefined,
    previousSummary,
    undefined,
    streamFn,
  );
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
    // The newest turn carries the live task and arrives verbatim.
    expect(conversation).toContain(`[User]: ask-1249 ${"context ".repeat(100)}`);
    const newestResult = serializeConversation(convertToLlm(messages.slice(-1)));
    expect(
      conversation.endsWith(
        `[Tool result of exec(cmd="run 1249")]${newestResult.slice("[Tool result]".length)}`,
      ),
    ).toBe(true);
    // The oldest turn usually states the goal of the session.
    expect(conversation).toContain("[User]: ask-0 ");
    // Every gap names its size, and the sizes add up to what was left out.
    const gaps = [...conversation.matchAll(/\[\.\.\. (\d+) entr(?:y|ies) omitted \.\.\.\]/gu)];
    expect(gaps.length).toBeGreaterThan(1);
    const kept = conversation
      .split("\n\n")
      .filter((part) => /^\[(User|Assistant|Assistant tool calls|Tool result)/u.test(part));
    const omitted = gaps.reduce((sum, gap) => sum + Number(gap[1]), 0);
    expect(kept.length + omitted).toBe(1_250 * 4);
    // Sampling can separate a result from its call, so each kept result names
    // the call that produced it.
    expect(conversation).not.toContain("[Tool result]:");
    const results = [
      ...conversation.matchAll(/\[Tool result of exec\(cmd="run (\d+)"\)\]: result-(\d+) /gu),
    ];
    expect(results.length).toBeGreaterThan(3);
    expect(results.filter((result) => result[1] !== result[2])).toEqual([]);
    expect(results).toHaveLength([...conversation.matchAll(/ result-\d+ /gu)].length);
    // The summarizer is told about the gaps, and the previous summary stays outside the budget.
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
      messages: [{ role: "user", content: "hello", timestamp: 1 }] satisfies AgentMessage[],
    },
  ])("fails without a model call when the window cannot hold $name", async ({ messages }) => {
    const { streamFn, prompts } = createCapturingStream();
    const result = await generateSummary(
      messages,
      createModel(4_096, 4_096),
      3_000,
      undefined,
      undefined,
      undefined,
      undefined,
      "漢".repeat(4_000),
      undefined,
      streamFn,
    );

    expect(prompts).toHaveLength(0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(SummaryOutputBudgetError);
      expect(result.error.message).toContain("agents.defaults.compaction.model");
    }
  });

  it("never exceeds a budget too small for one gap marker", () => {
    const messages: AgentMessage[] = [{ role: "user", content: "hello world", timestamp: 1 }];

    for (const budget of [0, 10, 18]) {
      const bounded = serializeConversationWithinBudget(convertToLlm(messages), budget);
      expect(bounded.text).not.toContain("hello");
      expect(bounded.omittedEntries).toBe(1);
    }
  });

  it("keeps both ends of a newest entry that alone exceeds the newest-entries share", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: `older ${"a".repeat(300_000)}`, timestamp: 1 },
      { role: "user", content: `NEWEST-HEAD ${"b".repeat(300_000)} NEWEST-TAIL`, timestamp: 2 },
    ];

    const bounded = serializeConversationWithinBudget(
      convertToLlm(messages),
      MAX_SUMMARY_INPUT_CHARS,
    );

    expect(estimateStringChars(bounded.text)).toBeLessThanOrEqual(MAX_SUMMARY_INPUT_CHARS);
    expect(bounded.text).toContain("[User]: NEWEST-HEAD b");
    expect(bounded.text.endsWith("b NEWEST-TAIL")).toBe(true);
    expect(bounded.text).toMatch(/\[\.\.\. \d+ characters omitted \.\.\.\]/u);
    expect(bounded.trimmedEntries).toBe(2);
    expect(bounded.omittedEntries).toBe(0);
  });

  it("keeps an excerpt of a huge newest entry that mixes CJK and ASCII text", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: `${"𠀀".repeat(500)}${"a".repeat(1_000_000)} END`, timestamp: 1 },
    ];

    const bounded = serializeConversationWithinBudget(
      convertToLlm(messages),
      MAX_SUMMARY_INPUT_CHARS,
    );

    expect(estimateStringChars(bounded.text)).toBeLessThanOrEqual(MAX_SUMMARY_INPUT_CHARS);
    expect(bounded.text.startsWith("[User]: 𠀀")).toBe(true);
    expect(bounded.text.endsWith("a END")).toBe(true);
    expect(bounded.omittedEntries).toBe(0);
  });

  it("counts CJK text by its token weight, not its length", () => {
    const messages: AgentMessage[] = Array.from({ length: 400 }, (_, index) => ({
      role: "user" as const,
      content: `${index} ${"漢字".repeat(1_000)}`,
      timestamp: index,
    }));

    const bounded = serializeConversationWithinBudget(
      convertToLlm(messages),
      MAX_SUMMARY_INPUT_CHARS,
    );

    expect(bounded.omittedEntries).toBeGreaterThan(0);
    expect(estimateStringChars(bounded.text)).toBeLessThanOrEqual(MAX_SUMMARY_INPUT_CHARS);
    expect(bounded.text.length).toBeLessThan(MAX_SUMMARY_INPUT_CHARS / 2);
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
      const { text } = serializeConversationWithinBudget(convertToLlm(messages), budget);
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
        { role: "user", content: "Write the report.", timestamp: 1 },
        toolCallMessage([{ id: "w-1", name: "write", cmd: "x".repeat(30_000) }]),
        toolResultMessage("w-1", "write", "WRITE-FAILED: disk full"),
      ];

      const { text } = serializeConversationWithinBudget(convertToLlm(messages), budget);

      expect(text).toMatch(/\[Tool result of write\(cmd="x+\.\.\.\)\]: WRITE-FAILED: disk full$/u);
      expect(estimateStringChars(text)).toBeLessThanOrEqual(budget);
    },
  );

  it("names the call of each result from a trimmed multi-call batch", () => {
    const names = Array.from({ length: 24 }, (_, index) => `tool${index}`);
    const messages: AgentMessage[] = [
      toolCallMessage(names.map((name) => ({ id: name, name, cmd: "y".repeat(10_000) }))),
      ...names.map((name) => toolResultMessage(name, name, `R-${name}`)),
      { role: "user", content: `NEWEST ${"z".repeat(200_000)}`, timestamp: 9 },
    ];

    const { text } = serializeConversationWithinBudget(
      convertToLlm(messages),
      MAX_SUMMARY_INPUT_CHARS,
    );

    for (const name of names) {
      expect(text).toMatch(
        new RegExp(`\\[Tool result of ${name}\\(cmd="y+\\.\\.\\.\\)\\]: R-${name}\\b`, "u"),
      );
    }
    expect(estimateStringChars(text)).toBeLessThanOrEqual(MAX_SUMMARY_INPUT_CHARS);
  });

  it("names the call of a result that follows an intervening user message", () => {
    const messages: AgentMessage[] = [
      ...createLongSession(60),
      toolCallMessage([{ id: "report", name: "write_report", cmd: "r".repeat(40_000) }]),
      { role: "user", content: "Any update?", timestamp: 2 },
      toolResultMessage("report", "write_report", "WRITE_FAILED: quota"),
    ];

    const { text } = serializeConversationWithinBudget(
      convertToLlm(messages),
      MAX_SUMMARY_INPUT_CHARS,
    );

    expect(text).toContain("entries omitted ...]");
    expect(text).toMatch(/\[Tool result of write_report\(cmd="r+\.\.\.\)\]: WRITE_FAILED: quota$/u);
  });

  it("sends a short history unchanged when the window is too small to sample", async () => {
    const { streamFn, prompts } = createCapturingStream();
    const messages: AgentMessage[] = [{ role: "user", content: "Rename the queue.", timestamp: 1 }];

    const result = await generateSummary(
      messages,
      createModel(4_096, 4_096),
      2_500,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      streamFn,
    );

    expect(result).toEqual({ ok: true, value: "summary" });
    expect(conversationOf(prompts[0] ?? "")).toBe("[User]: Rename the queue.");
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
      const result = await generateSummary(
        createLongSession(80),
        model,
        8_192,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        level,
        streamFn,
      );

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
    const result = await generateSummary(
      [{ role: "user", content: "Rename the queue.", timestamp: 1 }],
      model,
      4_096,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "high",
      streamFn,
    );

    expect(result).toEqual({ ok: true, value: "summary" });
    expect(conversationOf(prompts[0] ?? "")).toBe("[User]: Rename the queue.");
  });

  it("never labels a result with a call an earlier turn left unanswered", () => {
    const messages: AgentMessage[] = [
      toolCallMessage([{ id: "0", name: "exec", cmd: "delete A" }], "aborted"),
      toolCallMessage([{ id: "0", name: "exec", cmd: "write B" }]),
      toolResultMessage("0", "exec", "done"),
      { role: "user", content: `NEWEST ${"z".repeat(200_000)}`, timestamp: 9 },
    ];

    const { text } = serializeConversationWithinBudget(
      convertToLlm(messages),
      MAX_SUMMARY_INPUT_CHARS,
    );

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
      { role: "user", content: `NEWEST ${"z".repeat(200_000)}`, timestamp: 9 },
    ];

    const { text } = serializeConversationWithinBudget(
      convertToLlm(messages),
      MAX_SUMMARY_INPUT_CHARS,
    );

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
      messages[turn * 3] = { role: "user", content: text, timestamp: turn };
    }
    for (let turn = 0; turn < 400; turn += 1) {
      if (!decisions.some((decision) => decision.turn === turn)) {
        messages[turn * 3] = { role: "user", content: `ask-${turn}`, timestamp: turn };
      }
    }

    const { text } = serializeConversationWithinBudget(
      convertToLlm(messages),
      MAX_SUMMARY_INPUT_CHARS,
    );

    expect(estimateStringChars(text)).toBeLessThanOrEqual(MAX_SUMMARY_INPUT_CHARS);
    for (const { text: decision } of decisions) {
      expect(text).toContain(`[User]: ${decision}`);
    }
    for (let turn = 0; turn < 400; turn += 1) {
      expect(text).toMatch(new RegExp(`\\[User\\]: (?:ask|DECISION)-${turn}\\b`, "u"));
    }
  });

  it("spreads user messages across the history when they do not all fit", () => {
    const messages: AgentMessage[] = Array.from({ length: 2_000 }, (_, index) => ({
      role: "user" as const,
      content: `USER-${index} ${"note ".repeat(80)}`,
      timestamp: index,
    }));

    const { text } = serializeConversationWithinBudget(
      convertToLlm(messages),
      MAX_SUMMARY_INPUT_CHARS,
    );
    const kept = [...text.matchAll(/\[User\]: USER-(\d+) /gu)].map((match) => Number(match[1]));

    expect(estimateStringChars(text)).toBeLessThanOrEqual(MAX_SUMMARY_INPUT_CHARS);
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
    const result = await generateSummary(
      createLongSession(200),
      createModel(200_000, 64_000),
      16_384,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      streamFn,
    );

    expect(result).toEqual({ ok: true, value: "summary" });
    expect(prompts.length).toBeGreaterThan(1);
    expect(prompts.at(-1)?.length).toBeLessThanOrEqual(60_000);
    expect(prompts.at(-1)).toContain("entries omitted ...]");
  });

  it("stops with a budget error when the provider keeps rejecting the request as too long", async () => {
    const { streamFn, prompts } = createCapturingStream(() => true);
    const result = await generateSummary(
      createLongSession(200),
      createModel(200_000, 64_000),
      16_384,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      streamFn,
    );

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
    const result = await generateSummary(
      createLongSession(200),
      createModel(200_000, 64_000),
      16_384,
      undefined,
      undefined,
      controller.signal,
      undefined,
      undefined,
      undefined,
      streamFn,
      {
        completeSimple: vi.fn(),
        internalUsageSink: (entry) => {
          usage.push(entry);
        },
      },
    );

    expect(prompts).toHaveLength(1);
    expect(usage).toHaveLength(1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("aborted");
    }
  });
});
