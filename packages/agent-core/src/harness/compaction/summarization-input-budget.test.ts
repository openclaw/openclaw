import type { Model, StreamFn } from "@openclaw/llm-core";
import {
  CHARS_PER_TOKEN_ESTIMATE,
  estimateStringChars,
} from "@openclaw/normalization-core/cjk-chars";
import { describe, expect, it } from "vitest";
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

/** Records the summary prompt the provider receives and answers with a fixed summary. */
function createCapturingStream(): { streamFn: StreamFn; prompts: string[] } {
  const prompts: string[] = [];
  const streamFn: StreamFn = (model, context) => {
    const block = context.messages[0]?.content;
    prompts.push(Array.isArray(block) && block[0]?.type === "text" ? block[0].text : "");
    const stream = createAssistantMessageEventStream();
    stream.push({
      type: "done",
      reason: "stop",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "summary" }],
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
        stopReason: "stop",
        timestamp: 1,
      },
    });
    stream.end();
    return stream;
  };
  return { streamFn, prompts };
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
      content: [{ type: "text", text: "output ".repeat(1_500) }],
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
    expect(prompt).not.toContain("omitted from this summary input");
  });

  it("keeps one summary request bounded when the history fills a 1M-token window", async () => {
    const messages = createLongSession(1_250);
    expect(serializeConversation(convertToLlm(messages)).length).toBeGreaterThan(5_000_000);

    const prompt = await summarize(messages, createModel(1_000_000), "PREVIOUS-SUMMARY-FACT");
    const conversation = conversationOf(prompt);

    expect(estimateStringChars(conversation)).toBeLessThanOrEqual(MAX_SUMMARY_INPUT_CHARS);
    // The newest turn carries the live task and arrives verbatim.
    expect(conversation).toContain(`[User]: ask-1249 ${"context ".repeat(100)}`);
    expect(conversation.endsWith(serializeConversation(convertToLlm(messages.slice(-1))))).toBe(
      true,
    );
    // The oldest turn usually states the goal of the session.
    expect(conversation).toContain("[User]: ask-0 ");
    // Every gap names its size, and the sizes add up to what was left out.
    const gaps = [...conversation.matchAll(/\[\.\.\. (\d+) conversation entr(?:y|ies) omitted/gu)];
    expect(gaps.length).toBeGreaterThan(1);
    const kept = conversation
      .split("\n\n")
      .filter((part) => /^\[(User|Assistant|Assistant tool calls|Tool result)/u.test(part));
    const omitted = gaps.reduce((sum, gap) => sum + Number(gap[1]), 0);
    expect(kept.length + omitted).toBe(1_250 * 4);
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
    expect(prompt).toContain("omitted from this summary input");
  });

  it("fails without a model call when the window cannot hold the request", async () => {
    const { streamFn, prompts } = createCapturingStream();
    const result = await generateSummary(
      createLongSession(5),
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
});
