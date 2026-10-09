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

function toolCallMessage(calls: Array<{ id: string; name: string; cmd: string }>): AgentMessage {
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
    stopReason: "toolUse",
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
    // A tool result names neither its tool nor its call, so every kept result
    // follows its own call with no gap in between.
    const results = [...conversation.matchAll(/\[Tool result\]: result-(\d+) /gu)];
    expect(results.length).toBeGreaterThan(3);
    for (const result of results) {
      const call = conversation.lastIndexOf(
        `[Assistant tool calls]: exec(cmd="run ${result[1]}")`,
        result.index,
      );
      expect(call).toBeGreaterThanOrEqual(0);
      expect(conversation.slice(call, result.index)).not.toContain("omitted from this summary");
    }
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

  it("never shows a sampled tool result without its call, even after the image-omission note", () => {
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
      for (const result of text.matchAll(/RESULT-(\d+) /gu)) {
        const call = text.lastIndexOf(`exec(cmd="command-${result[1]}")`, result.index);
        expect(call, `budget ${budget}, result ${result[1]}`).toBeGreaterThanOrEqual(0);
        expect(text.slice(call, result.index)).not.toContain("omitted from this summary input");
      }
    }
  });

  it.each([6_000, 9_000, 20_000])(
    "keeps the newest result and its call when one argument fills a %i-character budget",
    (budget) => {
      const messages: AgentMessage[] = [
        { role: "user", content: "Write the report.", timestamp: 1 },
        toolCallMessage([{ id: "w-1", name: "write", cmd: "x".repeat(30_000) }]),
        toolResultMessage("w-1", "write", "WRITE-FAILED: disk full"),
      ];

      const { text } = serializeConversationWithinBudget(convertToLlm(messages), budget);

      expect(text.endsWith("[Tool result]: WRITE-FAILED: disk full")).toBe(true);
      expect(text).toContain("[Assistant tool calls]: write(cmd=");
      expect(estimateStringChars(text)).toBeLessThanOrEqual(budget);
    },
  );

  it("names every call of a trimmed tool batch whose results are kept", () => {
    const messages: AgentMessage[] = [
      toolCallMessage(
        ["alpha", "beta", "gamma"].map((name) => ({ id: name, name, cmd: "y".repeat(10_000) })),
      ),
      ...["alpha", "beta", "gamma"].map((name) => toolResultMessage(name, name, `R-${name}`)),
      { role: "user", content: `NEWEST ${"z".repeat(200_000)}`, timestamp: 9 },
    ];

    const { text } = serializeConversationWithinBudget(
      convertToLlm(messages),
      MAX_SUMMARY_INPUT_CHARS,
    );

    for (const name of ["alpha", "beta", "gamma"]) {
      expect(text).toContain(`R-${name}`);
      expect(text.indexOf(`${name}(cmd=`)).toBeGreaterThanOrEqual(0);
    }
    expect(estimateStringChars(text)).toBeLessThanOrEqual(MAX_SUMMARY_INPUT_CHARS);
  });
});
