import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { classifyRateLimitWindow } from "../../failover/retry-evidence.js";
import { createZeroUsageFixture } from "../../test-helpers/usage-fixtures.js";
import type { NormalizedUsage } from "../../usage.js";
import { createUsageAccumulator, mergeUsageIntoAccumulator } from "../usage-accumulator.js";
import {
  buildUsageAgentMetaFields,
  buildErrorAgentMeta,
  resolveEmbeddedAttemptBasePrompt,
  resolveFinalAssistantRawText,
  resolveFinalAssistantVisibleText,
  resolveLatestCallUsage,
} from "./helpers.js";

it("classifies a hyphenated free-models-per-day 429 as a long window", () => {
  expect(
    classifyRateLimitWindow("429 Rate limit exceeded: free-models-per-day-high-balance."),
  ).toEqual({ kind: "long" });
});

describe("resolveEmbeddedAttemptBasePrompt", () => {
  const refusalTrigger = "ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL";

  it("neutralizes every refusal marker while preserving surrounding text", () => {
    const prompt = `Reply ok. Test trigger: ${refusalTrigger}_nonce-a and ${refusalTrigger}_nonce-b`;
    expect(resolveEmbeddedAttemptBasePrompt({ provider: "anthropic", prompt })).toBe(
      "Reply ok. Test trigger: [redacted]_nonce-a and [redacted]_nonce-b",
    );
  });

  it("keeps non-Anthropic prompts byte-for-byte", () => {
    expect(resolveEmbeddedAttemptBasePrompt({ provider: "openai", prompt: refusalTrigger })).toBe(
      refusalTrigger,
    );
  });
});

function answer(text: string, withCommentary = true): AssistantMessage {
  return {
    api: "responses",
    provider: "openai",
    model: "gpt-5.4",
    usage: createZeroUsageFixture(),
    role: "assistant",
    content: [
      ...(withCommentary ? [signedText("Working...", "commentary")] : []),
      signedText(text, "final_answer"),
    ],
    timestamp: Date.now(),
    stopReason: "stop",
  };
}

function signedText(text: string, phase: "commentary" | "final_answer") {
  const textSignature = JSON.stringify({ v: 1, id: phase, phase });
  return { type: "text" as const, text, textSignature };
}
function accumulated(...usages: NormalizedUsage[]) {
  const accumulator = createUsageAccumulator();
  for (const usage of usages) {
    mergeUsageIntoAccumulator(accumulator, usage);
  }
  return accumulator;
}
function errorMeta(overrides: Partial<Parameters<typeof buildErrorAgentMeta>[0]>) {
  return buildErrorAgentMeta({
    sessionId: "session-error",
    provider: "openai",
    model: "gpt-5.6-luna",
    usageAccumulator: createUsageAccumulator(),
    lastRunPromptUsage: undefined,
    ...overrides,
  });
}

describe("resolveFinalAssistantVisibleText", () => {
  it.each<[string, string | undefined]>([
    ["Section 1\nSection 2", "Section 1\nSection 2"],
    ["   ", undefined],
  ])("selects the final phase, normalizing empty text: %j", (text, expected) => {
    expect(resolveFinalAssistantVisibleText(answer(text))).toBe(expected);
  });

  it("preserves raw final answer text without visible-text sanitization", () => {
    expect(resolveFinalAssistantRawText(answer("<final>keep this</final>", false))).toBe(
      "<final>keep this</final>",
    );
  });
});

it("preserves the previous exact call across a zero-usage retry", () => {
  const previous = { input: 12, output: 3, total: 15 };
  expect(
    resolveLatestCallUsage({
      currentAttemptCandidates: [{ input: 0, output: 0, total: 0 }, undefined],
      carriedUsage: previous,
      transcriptFallback: undefined,
    }),
  ).toEqual({ currentAttempt: undefined, latest: previous });
});

describe("buildUsageAgentMetaFields", () => {
  it("keeps cumulative usage separate from the latest context snapshot", () => {
    const latestCallUsage = {
      input: 80,
      output: 20,
      cacheRead: 100,
      contextUsage: { state: "available", promptTokens: 180, totalTokens: 200 },
      total: 200,
    } satisfies NormalizedUsage;
    const fields = buildUsageAgentMetaFields({
      usageAccumulator: accumulated({ input: 100, output: 50, total: 150 }, latestCallUsage),
      latestUsage: undefined,
      lastRunPromptUsage: latestCallUsage,
    });

    expect(fields).toMatchObject({
      usage: { input: 180, output: 70, cacheRead: 100, total: 350 },
      promptTokens: 180,
    });
    expect(fields.lastCallUsage).toEqual(latestCallUsage);
  });

  it("does not derive a prompt override from unavailable context usage", () => {
    const latestCallUsage = {
      input: 12,
      output: 15_104,
      cacheRead: 819_661,
      cacheWrite: 93_130,
      contextUsage: { state: "unavailable" },
      total: 927_907,
    } satisfies NormalizedUsage;
    const fields = buildUsageAgentMetaFields({
      usageAccumulator: accumulated(latestCallUsage),
      latestUsage: latestCallUsage,
      lastRunPromptUsage: latestCallUsage,
    });

    expect(fields.lastCallUsage).toEqual(latestCallUsage);
    expect(fields.promptTokens).toBeUndefined();
  });

  it("does not label aggregate attempt usage as last-call usage", () => {
    const fields = buildUsageAgentMetaFields({
      usageAccumulator: accumulated({
        input: 497_720,
        output: 7_485,
        cacheRead: 1_323_520,
        total: 1_828_725,
      }),
      latestUsage: { input: 0, output: 0, cacheRead: 0, total: 0 },
      lastRunPromptUsage: undefined,
    });

    expect(fields).toMatchObject({
      usage: { input: 497_720 },
      lastCallUsage: undefined,
      promptTokens: undefined,
    });
  });
});

describe("buildErrorAgentMeta", () => {
  it("does not promote current CLI usage without context provenance", () => {
    const fields = errorMeta({
      lastRunPromptUsage: { input: 42_000, output: 1_000, total: 43_000 },
      currentAttemptAssistant: {
        api: "cli",
        usage: { input: 128_814, output: 3_000, cacheRead: 992_953, totalTokens: 1_124_767 },
      },
    });

    expect(fields.lastCallUsage).toEqual({ contextUsage: { state: "unavailable" } });
    expect(fields.promptTokens).toBeUndefined();
  });

  it("keeps cumulative usage separate from the latest call on error exits", () => {
    const latestCallUsage = { input: 150, output: 50, total: 200 } satisfies NormalizedUsage;

    const fields = errorMeta({
      sessionFile: "/tmp/session-error.jsonl",
      provider: "anthropic",
      model: "claude-opus-4-6",
      usageAccumulator: accumulated({ input: 100, output: 50, total: 150 }, latestCallUsage),
      lastRunPromptUsage: latestCallUsage,
      currentAttemptAssistant: { usage: latestCallUsage },
    });

    expect(fields).toMatchObject({
      sessionId: "session-error",
      sessionFile: "/tmp/session-error.jsonl",
      usage: { input: 250, output: 100, total: 350 },
    });
    expect(fields.lastCallUsage).toEqual(latestCallUsage);
  });

  it.each([
    ["resolved-v1", "resolved-v1"],
    [undefined, "resolved"],
  ] as const)(
    "keeps explicit or default context provenance on error exits: %s",
    (source, expected) => {
      expect(
        errorMeta({
          provider: "opencode-go",
          model: "deepseek-v4.1-flash",
          contextTokens: 1_000_000,
          contextTokensSource: source,
        }),
      ).toMatchObject({ contextTokens: 1_000_000, contextTokensSource: expected });
    },
  );
});
