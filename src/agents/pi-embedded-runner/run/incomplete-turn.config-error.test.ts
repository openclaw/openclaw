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

  // Regression test: when the provider omits usage telemetry entirely (no
  // `usage` field on the assistant), we cannot prove the request never
  // reached the model. Without this guard the heuristic would misclassify
  // legitimate empty turns from usage-silent providers as config errors.
  it("does not flag when usage is missing (no telemetry to prove zero tokens)", () => {
    expect(
      isLikelyConfigErrorEmptyStream({
        payloadCount: 0,
        attempt: makeAttempt({
          lastAssistant: makeAssistant({ usage: undefined }),
        }),
      }),
    ).toBe(false);
  });

  it("does not flag when usage is an empty object (no recognizable fields)", () => {
    expect(
      isLikelyConfigErrorEmptyStream({
        payloadCount: 0,
        attempt: makeAttempt({
          // empty usage normalizes to undefined - same defer-to-generic path
          lastAssistant: makeAssistant({ usage: {} as never }),
        }),
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

  // Regression test for the empty-identity formatting bug: when both provider
  // and model are absent, we previously emitted a leading blank line followed
  // by an empty identity block followed by another blank line, rendering as
  // two consecutive blank lines between the header and the "Common causes:"
  // section.
  it("does not produce consecutive blank lines when identity block is empty", () => {
    const text = buildConfigErrorDiagnosticText({
      assistant: undefined,
      hadPotentialSideEffects: false,
    });
    expect(text).not.toMatch(/\n\n\n/);
  });

  // The OpenRouter URL hint is only useful when the failing call was actually
  // routed through OpenRouter — surfacing it for OpenAI / Groq / self-hosted
  // providers would point operators at the wrong place.
  it("omits the OpenRouter URL hint for non-openrouter providers", () => {
    const text = buildConfigErrorDiagnosticText({
      assistant: { provider: "openai", model: "gpt-5.4" },
      hadPotentialSideEffects: false,
    });
    expect(text).toContain("Provider: openai");
    expect(text).not.toContain("openrouter.ai/api/v1");
    expect(text).not.toContain("OpenRouter uses");
    expect(text).not.toMatch(/\n\n\n/);
  });

  it("includes the OpenRouter URL hint for openrouter providers", () => {
    const text = buildConfigErrorDiagnosticText({
      assistant: { provider: "openrouter", model: "z-ai/glm-5.1" },
      hadPotentialSideEffects: false,
    });
    expect(text).toContain("OpenRouter uses https://openrouter.ai/api/v1");
  });

  // Defensive: when we can't identify the provider at all, still surface the
  // hint — OpenRouter is the most common cause of this failure mode in
  // practice and the hint reads as advice rather than a definitive claim.
  it("includes the OpenRouter URL hint when provider is unknown", () => {
    const text = buildConfigErrorDiagnosticText({
      assistant: undefined,
      hadPotentialSideEffects: false,
    });
    expect(text).toContain("OpenRouter uses https://openrouter.ai/api/v1");
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
        didSendViaMessagingTool: false,
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
        didSendViaMessagingTool: false,
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
