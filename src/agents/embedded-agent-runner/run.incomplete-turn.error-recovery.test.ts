// Focused incomplete-turn behavior coverage.
import { describe, expect, it } from "vitest";
import { PROVIDER_POST_DISPATCH_AMBIGUITY_ERROR_CODE } from "../../llm/types.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import {
  DEFAULT_EMPTY_RESPONSE_RETRY_LIMIT,
  resolveEmptyResponseRetryInstruction,
  shouldRetrySilentErrorAssistantTurn,
} from "./run/incomplete-turn-recovery.js";
import { resolveIncompleteTurnPayloadText } from "./run/incomplete-turn-resolution.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

const EMPTY_RESPONSE_RETRY_INSTRUCTION =
  "The previous attempt did not produce a user-visible answer. Continue from the current state and produce the visible answer now. Do not restart from scratch.";

type LastAssistant = NonNullable<EmbeddedRunAttemptResult["lastAssistant"]>;

function makeLastAssistant(overrides: Record<string, unknown> = {}): LastAssistant {
  return { ...buildEmbeddedRunnerAssistant({}), ...overrides } as LastAssistant;
}

function makeAttemptResult(
  overrides: Partial<EmbeddedRunAttemptResult> = {},
): EmbeddedRunAttemptResult {
  return makeEmbeddedRunnerAttempt(overrides);
}

function retrySilentError(
  assistant: LastAssistant,
  overrides: Partial<EmbeddedRunAttemptResult> = {},
): boolean {
  return shouldRetrySilentErrorAssistantTurn({
    attempt: makeAttemptResult({ assistantTexts: [], lastAssistant: assistant, ...overrides }),
    assistant,
  });
}

function makeEmptyResponseRetryParams(
  attemptOverrides: Partial<EmbeddedRunAttemptResult> = {},
  overrides: Partial<
    Omit<Parameters<typeof resolveEmptyResponseRetryInstruction>[0], "attempt">
  > = {},
): Parameters<typeof resolveEmptyResponseRetryInstruction>[0] {
  return {
    provider: "openai",
    modelId: "gpt-5.6-luna",
    payloadCount: 0,
    aborted: false,
    timedOut: false,
    attempt: makeEmbeddedRunnerAttempt(attemptOverrides),
    ...overrides,
  };
}

function makeIncompleteTurnParams(
  attemptOverrides: Partial<EmbeddedRunAttemptResult> = {},
): Parameters<typeof resolveIncompleteTurnPayloadText>[0] {
  return {
    payloadCount: 0,
    aborted: false,
    externalAbort: false,
    timedOut: false,
    attempt: makeEmbeddedRunnerAttempt(attemptOverrides),
  };
}

describe("incomplete-turn error recovery", () => {
  it("retries replay-safe errored turns that only emitted thinking blocks", () => {
    const assistant = makeLastAssistant({
      stopReason: "error",
      provider: "anthropic",
      model: "claude-opus-4-8",
      content: [
        {
          type: "thinking",
          thinking: "internal reasoning before provider error",
          thinkingSignature: JSON.stringify({ id: "rs_error", type: "reasoning" }),
        },
        { type: "redacted_thinking", data: "opaque" },
        { type: "text", text: " " },
      ],
      usage: { input: 100, output: 1120, totalTokens: 1220 },
    });
    expect(retrySilentError(assistant)).toBe(true);
  });

  it("does not retry errored empty turns when non-zero output may indicate progress", () => {
    const assistant = makeLastAssistant({
      stopReason: "error",
      provider: "ollama",
      model: "glm-5.1:cloud",
      content: [{ type: "text", text: "" }],
      usage: { input: 100, output: 12, totalTokens: 112 },
    });
    expect(retrySilentError(assistant)).toBe(false);
  });

  it.each([
    {
      name: "the shared terminal argument parser",
      errorMessage: "Provider completed tool call with malformed JSON arguments",
    },
    {
      name: "an unsealed Anthropic tool block",
      errorMessage: "Provider completed stream with an incomplete tool call",
    },
    {
      name: "the OpenAI Chat Completions tool terminal",
      errorMessage: "Provider returned an incomplete or malformed tool call",
    },
    {
      name: "the Mistral tool terminal",
      errorMessage: "Mistral completed tool call has invalid JSON arguments",
    },
    {
      name: "the Responses tool terminal",
      errorMessage: "Responses stream completed tool call with invalid JSON arguments",
    },
  ])(
    "retries an empty errored turn with output tokens after a pre-dispatch rejection by $name",
    ({ errorMessage }) => {
      // Empty content and replay-safe attempt evidence are independent of the error message.
      const assistant = makeLastAssistant({
        stopReason: "error",
        provider: "anthropic",
        model: "claude-opus-5",
        errorMessage,
        usage: { input: 640, output: 1329, totalTokens: 1969 },
      });
      expect(retrySilentError(assistant)).toBe(true);
    },
  );

  it("retries an empty errored turn with output tokens on the structured rejection code", () => {
    const assistant = makeLastAssistant({
      stopReason: "error",
      provider: "anthropic",
      model: "claude-opus-5",
      errorCode: "malformed_tool_call_arguments",
      errorMessage: "Provider rejected the tool call",
      usage: { input: 640, output: 1329, totalTokens: 1969 },
    });
    expect(retrySilentError(assistant)).toBe(true);
  });

  it.each([
    "provider completed tool call with malformed JSON arguments",
    " Provider completed tool call with malformed JSON arguments",
    "Error: Provider completed tool call with malformed JSON arguments",
    "Provider completed tool call with malformed JSON arguments after dispatch",
  ])("does not retry positive output for a non-exact rejection message: %s", (errorMessage) => {
    const assistant = makeLastAssistant({
      stopReason: "error",
      errorMessage,
      usage: { input: 640, output: 13, totalTokens: 653 },
    });
    expect(retrySilentError(assistant)).toBe(false);
  });

  it.each([
    "MALFORMED_TOOL_CALL_ARGUMENTS",
    " malformed_tool_call_arguments",
    "malformed_tool_call_arguments_suffix",
  ])("does not retry positive output for an unrecognized rejection code: %s", (errorCode) => {
    const assistant = makeLastAssistant({
      stopReason: "error",
      errorCode,
      errorMessage: "Provider rejected the tool call",
      usage: { input: 640, output: 13, totalTokens: 653 },
    });
    expect(retrySilentError(assistant)).toBe(false);
  });

  it.each<{ name: string; attempt: Partial<EmbeddedRunAttemptResult> }>([
    { name: "visible text", attempt: { assistantTexts: ["Applying the edit now."] } },
    {
      name: "accepted client call",
      attempt: { clientToolCalls: [{ name: "pending", params: {} }] },
    },
    { name: "yielded work", attempt: { yieldDetected: true } },
    { name: "approval prompt", attempt: { didSendDeterministicApprovalPrompt: true } },
    { name: "source reply delivery", attempt: { didDeliverSourceReplyViaMessageTool: true } },
    {
      name: "asynchronous work",
      attempt: { toolMetas: [{ toolName: "probe", asyncStarted: true }] },
    },
    { name: "cron creation", attempt: { successfulCronAdds: 1 } },
    {
      name: "potential side effects",
      attempt: {
        toolMetas: [{ toolName: "write", replaySafe: false }],
        currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
      },
    },
  ])("keeps refusing a pre-dispatch rejection after $name", ({ attempt }) => {
    const assistant = makeLastAssistant({
      stopReason: "error",
      provider: "anthropic",
      model: "claude-opus-5",
      errorMessage: "Provider completed tool call with malformed JSON arguments",
      usage: { input: 640, output: 1329, totalTokens: 1969 },
    });
    expect(retrySilentError(assistant, attempt)).toBe(false);
  });

  it.each([
    { errorCode: "ERR_WEBSOCKET_NON_RETRYABLE_CLOSE" },
    { errorCode: PROVIDER_POST_DISPATCH_AMBIGUITY_ERROR_CODE },
    {
      errorCode: "malformed_tool_call_arguments",
      diagnostics: [
        {
          type: "provider_refusal",
          timestamp: 0,
          details: { provider: "anthropic", category: "cyber" },
        },
      ],
    },
  ])("preserves terminal rejection evidence: %j", (terminalEvidence) => {
    const assistant = makeLastAssistant({
      stopReason: "error",
      errorMessage: "Provider completed tool call with malformed JSON arguments",
      usage: { input: 640, output: 13, totalTokens: 653 },
      ...terminalEvidence,
    });
    expect(retrySilentError(assistant)).toBe(false);
  });

  it.each([
    {
      name: "visible text",
      content: [
        { type: "thinking", thinking: "internal", thinkingSignature: "sig" },
        { type: "text", text: "partial answer" },
      ],
    },
    {
      name: "tool call",
      content: [
        { type: "thinking", thinking: "internal", thinkingSignature: "sig" },
        { type: "toolCall", id: "call_1", name: "read", arguments: { path: "README.md" } },
      ],
    },
    {
      name: "unknown block",
      content: [{ type: "provider_metadata", value: "opaque" }],
    },
  ])("does not retry errored turns containing $name", ({ content }) => {
    const assistant = makeLastAssistant({
      stopReason: "error",
      provider: "anthropic",
      model: "claude-opus-4-8",
      errorMessage: "Provider completed tool call with malformed JSON arguments",
      content,
      usage: { input: 100, output: 1120, totalTokens: 1220 },
    });
    expect(retrySilentError(assistant)).toBe(false);
  });

  it("does not retry errored thinking-only turns after side effects", () => {
    const assistant = makeLastAssistant({
      stopReason: "error",
      provider: "anthropic",
      model: "claude-opus-4-8",
      content: [
        {
          type: "redacted_thinking",
          data: "opaque",
        },
      ],
      usage: { input: 100, output: 1120, totalTokens: 1220 },
    });
    expect(
      retrySilentError(assistant, {
        replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
      }),
    ).toBe(false);
  });

  it.each([
    ["current clean overrides cumulative dirty", true, false, true],
    ["current dirty overrides cumulative clean", false, true, false],
  ] as const)(
    "uses current-attempt replay metadata when %s",
    (_label, cumulativeDirty, currentDirty, expected) => {
      const assistant = makeLastAssistant({
        stopReason: "error",
        provider: "openrouter",
        model: "test-model",
        usage: { input: 100, output: 0, totalTokens: 100 },
      });
      expect(
        retrySilentError(assistant, {
          replayMetadata: {
            hadPotentialSideEffects: cumulativeDirty,
            replaySafe: !cumulativeDirty,
          },
          currentAttemptReplayMetadata: {
            hadPotentialSideEffects: currentDirty,
            replaySafe: !currentDirty,
          },
        }),
      ).toBe(expected);
    },
  );

  it("detects generic empty GPT turns without visible text", () => {
    const retryInstruction = resolveEmptyResponseRetryInstruction(
      makeEmptyResponseRetryParams({
        assistantTexts: [],
        lastAssistant: makeLastAssistant({
          stopReason: "end_turn",
          model: "gpt-5.4",
          content: [{ type: "text", text: "" }],
        }),
      }),
    );

    expect(retryInstruction).toBe(EMPTY_RESPONSE_RETRY_INSTRUCTION);
    expect(DEFAULT_EMPTY_RESPONSE_RETRY_LIMIT).toBe(1);
  });

  it("surfaces empty Codex app-server replies after successful sparse bash output", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText(
      makeIncompleteTurnParams({
        assistantTexts: [],
        toolMetas: [{ toolName: "bash", meta: "exit=0" }],
        messagesSnapshot: [
          {
            role: "toolResult",
            content: [{ type: "text", text: "" }],
            details: { aggregated: "" },
          } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
          makeLastAssistant({
            content: [{ type: "text", text: "" }],
          }),
        ],
        lastAssistant: makeLastAssistant({
          content: [{ type: "text", text: "" }],
        }),
      }),
    );

    expect(incompleteTurnText).toContain("couldn't generate a response");
    expect(incompleteTurnText).toContain("verify before retrying");
  });
});
