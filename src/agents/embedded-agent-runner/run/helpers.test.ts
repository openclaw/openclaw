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

describe("classifyRateLimitWindow - OpenRouter per-day cap", () => {
  it("classifies a hyphenated free-models-per-day 429 as a long window", () => {
    expect(
      classifyRateLimitWindow("429 Rate limit exceeded: free-models-per-day-high-balance."),
    ).toEqual({ kind: "long" });
  });
});

describe("resolveEmbeddedAttemptBasePrompt", () => {
  const refusalTrigger = "ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL";

  it.each([
    {
      prompt: `Reply ok. Test trigger: ${refusalTrigger}_nonce-a and ${refusalTrigger}_nonce-b`,
      expected: "Reply ok. Test trigger: [redacted]_nonce-a and [redacted]_nonce-b",
    },
  ])(
    "neutralizes every refusal marker while preserving surrounding text",
    ({ prompt, expected }) => {
      expect(resolveEmbeddedAttemptBasePrompt({ provider: "anthropic", prompt })).toBe(expected);
    },
  );

  it("keeps non-Anthropic prompts byte-for-byte", () => {
    expect(resolveEmbeddedAttemptBasePrompt({ provider: "openai", prompt: refusalTrigger })).toBe(
      refusalTrigger,
    );
  });
});

function makeAssistantMessage(
  content: AssistantMessage["content"],
  phase?: string,
): AssistantMessage {
  return {
    api: "responses",
    provider: "openai",
    model: "gpt-5.4",
    usage: createZeroUsageFixture(),
    role: "assistant",
    content,
    timestamp: Date.now(),
    stopReason: "stop",
    ...(phase ? { phase } : {}),
  };
}

function signedText(text: string, phase: "commentary" | "final_answer") {
  return {
    type: "text" as const,
    text,
    textSignature: JSON.stringify({
      v: 1,
      id: phase === "commentary" ? "item_commentary" : "item_final",
      phase,
    }),
  };
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
  it("prefers final_answer text over commentary blocks", () => {
    const lastAssistant = makeAssistantMessage([
      signedText("Working...", "commentary"),
      signedText("Section 1\nSection 2", "final_answer"),
    ]);

    expect(resolveFinalAssistantVisibleText(lastAssistant)).toBe("Section 1\nSection 2");
  });

  it("returns undefined when the final visible text is empty", () => {
    const lastAssistant = makeAssistantMessage([
      signedText("Working...", "commentary"),
      signedText("   ", "final_answer"),
    ]);

    expect(resolveFinalAssistantVisibleText(lastAssistant)).toBeUndefined();
  });

  it("preserves raw final answer text without visible-text sanitization", () => {
    const lastAssistant = makeAssistantMessage([
      signedText("<final>keep this</final>", "final_answer"),
    ]);

    expect(resolveFinalAssistantRawText(lastAssistant)).toBe("<final>keep this</final>");
  });
});

describe("resolveLatestCallUsage", () => {
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
});

describe("buildUsageAgentMetaFields", () => {
  it("keeps cumulative usage separate from the latest context snapshot", () => {
    const usageAccumulator = accumulated({ input: 100, output: 50, total: 150 });
    const latestCallUsage = {
      input: 80,
      output: 20,
      cacheRead: 100,
      contextUsage: { state: "available", promptTokens: 180, totalTokens: 200 },
      total: 200,
    } satisfies NormalizedUsage;
    mergeUsageIntoAccumulator(usageAccumulator, latestCallUsage);

    const fields = buildUsageAgentMetaFields({
      usageAccumulator,
      latestUsage: undefined,
      lastRunPromptUsage: latestCallUsage,
    });

    expect(fields.usage).toMatchObject({
      input: 180,
      output: 70,
      cacheRead: 100,
      total: 350,
    });
    expect(fields.lastCallUsage).toEqual(latestCallUsage);
    expect(fields.promptTokens).toBe(180);
  });

  it("does not derive a prompt override from unavailable context usage", () => {
    const usageAccumulator = createUsageAccumulator();
    const latestCallUsage = {
      input: 12,
      output: 15_104,
      cacheRead: 819_661,
      cacheWrite: 93_130,
      contextUsage: { state: "unavailable" },
      total: 927_907,
    } satisfies NormalizedUsage;
    mergeUsageIntoAccumulator(usageAccumulator, latestCallUsage);

    const fields = buildUsageAgentMetaFields({
      usageAccumulator,
      latestUsage: latestCallUsage,
      lastRunPromptUsage: latestCallUsage,
    });

    expect(fields.lastCallUsage).toEqual(latestCallUsage);
    expect(fields.promptTokens).toBeUndefined();
  });

  it("does not label aggregate attempt usage as last-call usage", () => {
    const usageAccumulator = accumulated({
      input: 497_720,
      output: 7_485,
      cacheRead: 1_323_520,
      total: 1_828_725,
    });

    const fields = buildUsageAgentMetaFields({
      usageAccumulator,
      latestUsage: { input: 0, output: 0, cacheRead: 0, total: 0 },
      lastRunPromptUsage: undefined,
    });

    expect(fields.usage?.input).toBe(497_720);
    expect(fields.lastCallUsage).toBeUndefined();
    expect(fields.promptTokens).toBeUndefined();
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
    const usageAccumulator = accumulated({ input: 100, output: 50, total: 150 });
    const latestCallUsage = { input: 150, output: 50, total: 200 } satisfies NormalizedUsage;
    mergeUsageIntoAccumulator(usageAccumulator, latestCallUsage);

    const fields = errorMeta({
      sessionFile: "/tmp/session-error.jsonl",
      provider: "anthropic",
      model: "claude-opus-4-6",
      usageAccumulator,
      lastRunPromptUsage: latestCallUsage,
      currentAttemptAssistant: { usage: latestCallUsage },
    });

    expect(fields).toMatchObject({
      sessionId: "session-error",
      sessionFile: "/tmp/session-error.jsonl",
    });
    expect(fields.usage).toMatchObject({ input: 250, output: 100, total: 350 });
    expect(fields.lastCallUsage).toEqual(latestCallUsage);
  });

  it("keeps the run's context provenance on error exits", () => {
    const build = (contextTokensSource?: "resolved-v1") =>
      errorMeta({
        provider: "opencode-go",
        model: "deepseek-v4.1-flash",
        contextTokens: 1_000_000,
        contextTokensSource,
      });

    expect(build("resolved-v1")).toMatchObject({
      contextTokens: 1_000_000,
      contextTokensSource: "resolved-v1",
    });
    expect(build()).toMatchObject({ contextTokens: 1_000_000, contextTokensSource: "resolved" });
  });
});
