import { describe, expect, it } from "vitest";
import {
  buildEmbeddedRunnerAssistant,
  createMockUsage,
  makeEmbeddedRunnerAttempt,
} from "../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { hasOutboundDeliveryEvidence } from "./delivery-evidence.js";
import { buildAttemptReplayMetadata } from "./run/attempt-terminal-evidence.js";
import {
  resolveNonVisibleTurnRetryInstructions,
  shouldRetrySilentErrorAssistantTurn,
} from "./run/incomplete-turn-recovery.js";
import {
  resolveIncompleteTurnPayloadText,
  shouldRetryMissingAssistantTurn,
} from "./run/incomplete-turn-resolution.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

const EMPTY_RETRY =
  "Your turn ended without a final reply. If the user still needs a reply, write it now. If your completed actions already answered the request, answer exactly NO_REPLY. Continue from the current state; do not restart from scratch.";
const REJECTION = "Provider completed tool call with malformed JSON arguments";
const spawn = { runId: "child", childSessionKey: "agent:test:subagent:child" };
type Assistant = NonNullable<EmbeddedRunAttemptResult["lastAssistant"]>;
type Attempt = Partial<EmbeddedRunAttemptResult>;

function assistant(overrides: Partial<Assistant> = {}) {
  return buildEmbeddedRunnerAssistant({ model: "gpt-5.4", ...overrides });
}

function retryState(attempt: Attempt = {}) {
  return {
    provider: "openai",
    modelId: "gpt-5.4",
    replyDeliveryState: "missing" as const,
    payloadCount: 0,
    settledToolPayloadCount: 0,
    aborted: false,
    timedOut: false,
    attempt: makeEmbeddedRunnerAttempt({ lastAssistant: assistant(), ...attempt }),
  };
}

function warning(
  attempt: Attempt = {},
  overrides: Partial<Omit<Parameters<typeof resolveIncompleteTurnPayloadText>[0], "attempt">> = {},
) {
  return resolveIncompleteTurnPayloadText({
    ...retryState(attempt),
    externalAbort: false,
    ...overrides,
  });
}

describe("incomplete-turn retry classification", () => {
  it.each([
    ["ollama", "minimax-m2.7:cloud", 6, EMPTY_RETRY, undefined],
    ["ollama", "glm-5.1:cloud", 0, null, undefined],
    ["llmman", "qwen3.5:0.8b", 6, EMPTY_RETRY, "ollama"],
    ["llmman", "qwen3.5:0.8b", 0, null, "ollama"],
    ["openai", "gpt-5.5", 111, EMPTY_RETRY, "openai-chatgpt-responses"],
  ] as const)("handles empty %s/%s output", (provider, modelId, output, expected, modelApi) => {
    const instructions = resolveNonVisibleTurnRetryInstructions({
      ...retryState({ lastAssistant: assistant({ usage: createMockUsage(100, output) }) }),
      provider,
      modelId,
      modelApi,
    });
    expect(instructions[1]).toBe(expected);
  });

  const errorCases: Array<[string, Partial<Assistant>, Attempt?]> = [
    ["non-exact rejection message", { errorMessage: `${REJECTION} after dispatch` }],
    [
      "provider refusal",
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
    ],
    ["asynchronous work", {}, { toolMetas: [{ toolName: "probe", asyncStarted: true }] }],
  ];
  it.each(errorCases)("rejects silent error retry with %s", (_name, overrides, attempt) => {
    const message = assistant({
      stopReason: "error",
      errorMessage: REJECTION,
      usage: createMockUsage(640, 1329),
      ...overrides,
    });
    const retry = shouldRetrySilentErrorAssistantTurn({
      assistant: message,
      attempt: makeEmbeddedRunnerAttempt({ lastAssistant: message, ...attempt }),
    });
    expect(retry).toBe(false);
  });
});

describe("incomplete-turn delivery ownership", () => {
  it.each([
    { state: "delivered", sourceDelivered: false, expected: null },
    { state: "missing", sourceDelivered: true, expected: expect.any(String) },
  ] as const)(
    "honors current-source $state over aggregate sends",
    ({ state, sourceDelivered, expected }) => {
      const result = warning({
        sourceReplyDeliveryState: state,
        sourceReplyDelivered: sourceDelivered ? true : undefined,
        didSendViaMessagingTool: true,
        messagingToolSentTexts: ["A message was sent."],
        messagingToolSentMediaUrls: ["file:///tmp/render.png"],
        lastAssistant: assistant({
          stopReason: "error",
          errorMessage: "provider failed after delivery",
        }),
      });
      expect(result).toEqual(expected);
    },
  );

  it("suppresses warnings for a spawn owning completion", () => {
    const result = warning(
      {
        acceptedSessionSpawns: [{ ...spawn, expectsCompletionMessage: true }],
      },
      { hadPotentialSideEffects: true },
    );
    expect(result).toBeNull();
  });

  it("marks an accepted spawn as replay-invalid", () => {
    const evidence = { acceptedSessionSpawns: [spawn] };
    const replay = buildAttemptReplayMetadata({
      toolMetas: [],
      didSendViaMessagingTool: false,
      messagingToolSentTexts: [],
      messagingToolSentMediaUrls: [],
      ...evidence,
    });
    expect(replay).toEqual({ hadPotentialSideEffects: true, replaySafe: false });
    expect(hasOutboundDeliveryEvidence(evidence)).toBe(true);
  });
});

describe("incomplete-turn payload resolution", () => {
  it("surfaces interrupted tool-only output except after explicit cancellation", () => {
    const attempt = {
      lastAssistant: undefined,
      toolMetas: [{ toolName: "bash", meta: "workspace" }],
    };
    const expected =
      "No answer was returned. Ask again if you still need one. Note: some tool actions may have already been executed — please verify before retrying.";
    expect(warning(attempt)).toBe(expected);
    expect(warning(attempt, { aborted: true, externalAbort: true })).toBeNull();
    expect(warning(attempt, { aborted: true })).toBe(expected);
  });

  it("allows a same-prompt retry only for replay-safe missing assistant turns", () => {
    const attempts: Attempt[] = [
      { lastAssistant: undefined },
      { toolMetas: [{ toolName: "image_generate", asyncStarted: true }] },
      { itemLifecycle: { startedCount: 1, completedCount: 0, activeCount: 1 } },
    ];
    const retries = attempts.map((attempt) =>
      shouldRetryMissingAssistantTurn(retryState({ lastAssistant: undefined, ...attempt })),
    );
    expect(retries).toEqual([true, false, false]);
  });

  it.each([
    [
      "unsigned thinking only (#89787)",
      { content: [{ type: "thinking", thinking: "internal reasoning" }] },
      1,
      "No answer was returned. Ask again if you still need one.",
    ],
    [
      "empty token-limited answer",
      { stopReason: "length", content: [{ type: "text", text: "" }] },
      0,
      "⚠️ The model reached its output token limit before generating an answer. Please try again.",
    ],
  ] satisfies Array<[string, Partial<Assistant>, number, string]>)(
    "resolves warning for %s",
    (_name, message, payloadCount, expected) => {
      const result = warning(
        { assistantTexts: [], lastAssistant: assistant(message) },
        { payloadCount },
      );
      expect(result).toContain(expected);
    },
  );
});
