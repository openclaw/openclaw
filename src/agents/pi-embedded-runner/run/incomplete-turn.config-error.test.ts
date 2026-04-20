import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
  buildConfigErrorDiagnosticText,
  isLikelyConfigErrorEmptyStream,
  resolveIncompleteTurnPayloadText,
} from "./incomplete-turn.js";

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;

function makeAssistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    usage: { ...ZERO_USAGE },
    stopReason: "stop",
    ...overrides,
  } as AssistantMessage;
}

type AttemptSlice = Parameters<typeof isLikelyConfigErrorEmptyStream>[0]["attempt"];

function makeAttempt(overrides: Partial<AttemptSlice> = {}): AttemptSlice {
  return {
    assistantTexts: [],
    currentAttemptAssistant: undefined,
    lastAssistant: makeAssistant(),
    ...overrides,
  };
}

describe("isLikelyConfigErrorEmptyStream", () => {
  it("flags a zero-content, zero-token, stop-terminated stream as a config error", () => {
    expect(
      isLikelyConfigErrorEmptyStream({
        payloadCount: 0,
        attempt: makeAttempt(),
      }),
    ).toBe(true);
  });

  it("does not flag when the assistant produced any visible text", () => {
    expect(
      isLikelyConfigErrorEmptyStream({
        payloadCount: 0,
        attempt: makeAttempt({ assistantTexts: ["partial answer"] }),
      }),
    ).toBe(false);
  });

  it("does not flag when any payload was emitted", () => {
    expect(
      isLikelyConfigErrorEmptyStream({
        payloadCount: 1,
        attempt: makeAttempt(),
      }),
    ).toBe(false);
  });

  it("does not flag when usage shows real token activity", () => {
    expect(
      isLikelyConfigErrorEmptyStream({
        payloadCount: 0,
        attempt: makeAttempt({
          lastAssistant: makeAssistant({
            usage: {
              ...ZERO_USAGE,
              input: 12,
              totalTokens: 12,
              cost: { ...ZERO_USAGE.cost },
            },
          }),
        }),
      }),
    ).toBe(false);
  });

  // Regression test: `AssistantMessage.usage` reports its aggregate on
  // `totalTokens`, not on the normalized `total` field that `hasNonzeroUsage`
  // inspects directly. Some provider conversion paths (e.g. the OpenAI WS
  // path) populate only `totalTokens` — without normalization the detector
  // would misclassify such a real model turn as a zero-token config error.
  it("does not flag when only totalTokens is populated (provider aggregate)", () => {
    expect(
      isLikelyConfigErrorEmptyStream({
        payloadCount: 0,
        attempt: makeAttempt({
          lastAssistant: makeAssistant({
            usage: {
              ...ZERO_USAGE,
              totalTokens: 500,
              cost: { ...ZERO_USAGE.cost },
            },
          }),
        }),
      }),
    ).toBe(false);
  });

  it("does not flag when the assistant has any content blocks", () => {
    expect(
      isLikelyConfigErrorEmptyStream({
        payloadCount: 0,
        attempt: makeAttempt({
          lastAssistant: makeAssistant({
            content: [{ type: "thinking", thinking: "reasoning only" }],
          }),
        }),
      }),
    ).toBe(false);
  });

  it("defers to the normal error path when the stream itself reported an error", () => {
    expect(
      isLikelyConfigErrorEmptyStream({
        payloadCount: 0,
        attempt: makeAttempt({
          lastAssistant: makeAssistant({ stopReason: "error" }),
        }),
      }),
    ).toBe(false);
  });

  it("does not flag when there is no assistant message at all", () => {
    expect(
      isLikelyConfigErrorEmptyStream({
        payloadCount: 0,
        attempt: makeAttempt({ lastAssistant: undefined }),
      }),
    ).toBe(false);
  });

  it("prefers currentAttemptAssistant over lastAssistant when both are present", () => {
    expect(
      isLikelyConfigErrorEmptyStream({
        payloadCount: 0,
        attempt: makeAttempt({
          currentAttemptAssistant: makeAssistant({
            usage: {
              ...ZERO_USAGE,
              input: 50,
              totalTokens: 50,
              cost: { ...ZERO_USAGE.cost },
            },
          }),
          lastAssistant: makeAssistant(),
        }),
      }),
    ).toBe(false);
  });
});

describe("buildConfigErrorDiagnosticText", () => {
  it("includes provider and model when available", () => {
    const text = buildConfigErrorDiagnosticText({
      assistant: { provider: "openrouter", model: "moonshotai/kimi-k2.5" },
      hadPotentialSideEffects: false,
    });
    expect(text).toContain("Provider: openrouter");
    expect(text).toContain("Model:    moonshotai/kimi-k2.5");
    expect(text).toContain("openrouter.ai/api/v1");
    expect(text).not.toContain("tool actions may have already");
  });

  it("appends a side-effects warning when applicable", () => {
    const text = buildConfigErrorDiagnosticText({
      assistant: { provider: "openrouter", model: "kimi-k2.5" },
      hadPotentialSideEffects: true,
    });
    expect(text).toContain("tool actions may have already been executed");
  });

  it("omits missing identifiers gracefully", () => {
    const text = buildConfigErrorDiagnosticText({
      assistant: undefined,
      hadPotentialSideEffects: false,
    });
    expect(text).not.toContain("Provider:");
    expect(text).not.toContain("Model:");
    expect(text).toContain("Run `openclaw doctor`");
  });
});

describe("resolveIncompleteTurnPayloadText — config-error path", () => {
  it("emits the detailed diagnostic for an empty-stream config error", () => {
    const result = resolveIncompleteTurnPayloadText({
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: {
        assistantTexts: [],
        lastAssistant: makeAssistant({
          provider: "openrouter",
          model: "moonshotai/kimi-k2.5",
        }),
        currentAttemptAssistant: undefined,
        clientToolCall: undefined,
        yieldDetected: false,
        didSendDeterministicApprovalPrompt: false,
        lastToolError: undefined,
        replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
        promptErrorSource: null,
        timedOutDuringCompaction: false,
      },
    });

    expect(result).toContain("Provider returned an empty stream");
    expect(result).toContain("Provider: openrouter");
    expect(result).toContain("Model:    moonshotai/kimi-k2.5");
    expect(result).toContain("openrouter.ai/api/v1");
  });

  it("falls back to the generic message when a legitimate reasoning-only turn emits nothing visible", () => {
    const result = resolveIncompleteTurnPayloadText({
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: {
        assistantTexts: [],
        lastAssistant: makeAssistant({
          usage: {
            ...ZERO_USAGE,
            input: 200,
            output: 80,
            totalTokens: 280,
            cost: { ...ZERO_USAGE.cost },
          },
          content: [{ type: "thinking", thinking: "long reasoning" }],
        }),
        currentAttemptAssistant: undefined,
        clientToolCall: undefined,
        yieldDetected: false,
        didSendDeterministicApprovalPrompt: false,
        lastToolError: undefined,
        replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
        promptErrorSource: null,
        timedOutDuringCompaction: false,
      },
    });

    expect(result).toContain("Agent couldn't generate a response");
    expect(result).not.toContain("Provider returned an empty stream");
  });
});
