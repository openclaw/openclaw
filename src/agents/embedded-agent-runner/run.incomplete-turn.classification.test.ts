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
type Assistant = NonNullable<EmbeddedRunAttemptResult["lastAssistant"]>;
type Attempt = Partial<EmbeddedRunAttemptResult>;

function assistant(overrides: Partial<Assistant> = {}) {
  return buildEmbeddedRunnerAssistant({ model: "gpt-5.4", ...overrides });
}

function thinking(thinkingSignature?: string): Assistant["content"] {
  return [{ type: "thinking", thinking: "internal reasoning", thinkingSignature }];
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

function retryError(overrides: Partial<Assistant> = {}, attempt: Attempt = {}) {
  const message = assistant({
    stopReason: "error",
    errorMessage: REJECTION,
    usage: createMockUsage(640, 1329),
    ...overrides,
  });
  return shouldRetrySilentErrorAssistantTurn({
    assistant: message,
    attempt: makeEmbeddedRunnerAttempt({ lastAssistant: message, ...attempt }),
  });
}

describe("incomplete-turn retry classification", () => {
  it.each([
    { provider: "ollama", modelId: "minimax-m2.7:cloud", output: 6, expected: EMPTY_RETRY },
    { provider: "ollama", modelId: "glm-5.1:cloud", output: 0, expected: null },
    {
      provider: "openai",
      modelId: "gpt-5.5",
      modelApi: "openai-chatgpt-responses",
      output: 111,
      expected: EMPTY_RETRY,
    },
  ])("handles empty $provider output with $output tokens", ({ expected, output, ...route }) => {
    expect(
      resolveNonVisibleTurnRetryInstructions({
        ...retryState({ lastAssistant: assistant({ usage: createMockUsage(100, output) }) }),
        ...route,
      })[1],
    ).toBe(expected);
  });

  const errorCases: Array<[string, boolean, Partial<Assistant>?, Attempt?]> = [
    ["non-exact rejection message", false, { errorMessage: `${REJECTION} after dispatch` }],
    [
      "provider refusal",
      false,
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
    ["asynchronous work", false, {}, { toolMetas: [{ toolName: "probe", asyncStarted: true }] }],
  ];
  it.each(errorCases)(
    "classifies silent error retry with %s",
    (_name, expected, message, attempt) => {
      expect(retryError(message, attempt)).toBe(expected);
    },
  );
});

describe("incomplete-turn delivery ownership", () => {
  it.each([
    { state: "delivered", sourceDelivered: false, expected: null },
    { state: "missing", sourceDelivered: true, expected: expect.any(String) },
  ] as const)(
    "honors current-source $state over aggregate sends",
    ({ state, sourceDelivered, expected }) => {
      expect(
        warning({
          sourceReplyDeliveryState: state,
          sourceReplyDelivered: sourceDelivered ? true : undefined,
          didSendViaMessagingTool: true,
          messagingToolSentTexts: ["A message was sent."],
          messagingToolSentMediaUrls: ["file:///tmp/render.png"],
          lastAssistant: assistant({
            stopReason: "error",
            errorMessage: "provider failed after delivery",
          }),
        }),
      ).toEqual(expected);
    },
  );

  it("suppresses warnings for a spawn owning completion", () => {
    const result = warning(
      {
        acceptedSessionSpawns: [
          {
            runId: "child",
            childSessionKey: "agent:test:subagent:child",
            expectsCompletionMessage: true,
          },
        ],
      },
      { hadPotentialSideEffects: true },
    );
    expect(result).toBeNull();
  });

  it("marks an accepted spawn as replay-invalid", () => {
    const evidence = {
      acceptedSessionSpawns: [{ runId: "child", childSessionKey: "agent:test:subagent:child" }],
    };
    expect(
      buildAttemptReplayMetadata({
        toolMetas: [],
        didSendViaMessagingTool: false,
        messagingToolSentTexts: [],
        messagingToolSentMediaUrls: [],
        ...evidence,
      }),
    ).toEqual({ hadPotentialSideEffects: true, replaySafe: false });
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
    expect(
      attempts.map((attempt) =>
        shouldRetryMissingAssistantTurn(retryState({ lastAssistant: undefined, ...attempt })),
      ),
    ).toEqual([true, false, false]);
  });

  const payloadCases: Array<[string, Attempt, number, string]> = [
    [
      "unsigned thinking only (#89787)",
      { lastAssistant: assistant({ content: thinking() }) },
      1,
      "No answer was returned. Ask again if you still need one.",
    ],
    [
      "empty token-limited answer",
      {
        assistantTexts: [],
        lastAssistant: assistant({ stopReason: "length", content: [{ type: "text", text: "" }] }),
      },
      0,
      "⚠️ The model reached its output token limit before generating an answer. Please try again.",
    ],
  ];
  it.each(payloadCases)("resolves warning for %s", (_name, attempt, payloadCount, expected) => {
    const result = warning(attempt, { payloadCount });
    expect(result).toContain(expected);
  });
});
