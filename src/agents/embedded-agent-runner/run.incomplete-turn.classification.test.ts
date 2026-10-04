import { describe, expect, it } from "vitest";
import { PROVIDER_POST_DISPATCH_AMBIGUITY_ERROR_CODE } from "../../llm/types.js";
import {
  buildEmbeddedRunnerAssistant,
  createMockUsage,
  makeEmbeddedRunnerAttempt,
} from "../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { hasOutboundDeliveryEvidence } from "./delivery-evidence.js";
import { buildAttemptReplayMetadata } from "./run/attempt-terminal-evidence.js";
import {
  resolveEmptyResponseRetryInstruction,
  resolveReasoningOnlyRetryInstruction,
  shouldRetrySilentErrorAssistantTurn,
} from "./run/incomplete-turn-recovery.js";
import {
  resolveIncompleteTurnPayloadText,
  shouldRetryMissingAssistantTurn,
} from "./run/incomplete-turn-resolution.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

const REASONING_RETRY =
  "The previous assistant turn recorded reasoning but did not produce a user-visible answer. Continue from that partial turn and produce the visible answer now. Do not restate the reasoning or restart from scratch.";
const EMPTY_RETRY =
  "The previous attempt did not produce a user-visible answer. Continue from the current state and produce the visible answer now. Do not restart from scratch.";
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
    payloadCount: 0,
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
    ["google", "gemini-2.5-pro", undefined, "signed"],
    ["ollama", "gemma4:31b", undefined, "signed"],
    ["openai", "qwen3.6-35b-a3b", "openai-completions", undefined],
  ])("continues reasoning-only output for %s/%s", (provider, modelId, modelApi, signature) => {
    expect(
      resolveReasoningOnlyRetryInstruction({
        ...retryState({ lastAssistant: assistant({ content: thinking(signature) }) }),
        provider,
        modelId,
        modelApi,
      }),
    ).toBe(REASONING_RETRY);
  });

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
      resolveEmptyResponseRetryInstruction({
        ...retryState({ lastAssistant: assistant({ usage: createMockUsage(100, output) }) }),
        ...route,
      }),
    ).toBe(expected);
  });

  const errorCases: Array<[string, boolean, Partial<Assistant>?, Attempt?]> = [
    ["signed thinking", true, { errorMessage: undefined, content: thinking("signed") }],
    ["exact rejection message", true, { errorMessage: REJECTION }],
    [
      "rejection code",
      true,
      {
        errorMessage: "Provider rejected the tool call",
        errorCode: "malformed_tool_call_arguments",
      },
    ],
    ["non-exact rejection message", false, { errorMessage: `${REJECTION} after dispatch` }],
    [
      "non-exact rejection code",
      false,
      {
        errorMessage: "Provider rejected the tool call",
        errorCode: "malformed_tool_call_arguments_suffix",
      },
    ],
    ["post-dispatch ambiguity", false, { errorCode: PROVIDER_POST_DISPATCH_AMBIGUITY_ERROR_CODE }],
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
    ["visible text", false, {}, { assistantTexts: ["Applying the edit now."] }],
    ["accepted client call", false, {}, { clientToolCalls: [{ name: "pending", params: {} }] }],
    ["asynchronous work", false, {}, { toolMetas: [{ toolName: "probe", asyncStarted: true }] }],
    [
      "tool call",
      false,
      {
        content: [
          ...thinking("signed"),
          { type: "toolCall", id: "call_1", name: "read", arguments: { path: "README.md" } },
        ],
      },
    ],
    ...[false, true].map((current): [string, boolean, Partial<Assistant>, Attempt] => [
      `current ${current ? "dirty" : "clean"} overrides cumulative evidence`,
      !current,
      { errorMessage: undefined, usage: createMockUsage(100, 0) },
      {
        replayMetadata: { hadPotentialSideEffects: !current, replaySafe: current },
        currentAttemptReplayMetadata: { hadPotentialSideEffects: current, replaySafe: !current },
      },
    ]),
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

  it.each([true, false])(
    "suppresses warnings only for a spawn owning completion: %s",
    (expectsCompletionMessage) => {
      const result = warning(
        {
          acceptedSessionSpawns: [
            {
              runId: "child",
              childSessionKey: "agent:test:subagent:child",
              expectsCompletionMessage,
            },
          ],
        },
        { hadPotentialSideEffects: true },
      );
      expect(result).toBe(
        expectsCompletionMessage
          ? null
          : "⚠️ Agent couldn't generate a response. Note: some tool actions may have already been executed — please verify before retrying.",
      );
    },
  );

  it.each([
    { messagingToolSentTargets: [{ tool: "message", provider: "slack", to: "channel-1" }] },
    { acceptedSessionSpawns: [{ runId: "child", childSessionKey: "agent:test:subagent:child" }] },
  ])("marks committed outbound delivery as replay-invalid: %j", (evidence) => {
    expect(
      buildAttemptReplayMetadata({
        toolMetas: [],
        didSendViaMessagingTool: false,
        messagingToolSentTexts: [],
        messagingToolSentMediaUrls: [],
        ...evidence,
      }),
    ).toEqual({ hadPotentialSideEffects: true, replaySafe: false });
    if (evidence.acceptedSessionSpawns) {
      expect(hasOutboundDeliveryEvidence(evidence)).toBe(true);
    }
  });
});

describe("incomplete-turn payload resolution", () => {
  it("surfaces interrupted tool-only output except after explicit cancellation", () => {
    const attempt = {
      lastAssistant: undefined,
      toolMetas: [{ toolName: "bash", meta: "workspace" }],
    };
    expect(warning(attempt)).toContain("couldn't generate a response");
    expect(warning(attempt, { aborted: true, externalAbort: true })).toBeNull();
    expect(warning(attempt, { aborted: true })).toContain("couldn't generate a response");
  });

  it("allows a same-prompt retry only for replay-safe missing assistant turns", () => {
    const state = retryState({ lastAssistant: undefined });
    expect(shouldRetryMissingAssistantTurn(state)).toBe(true);
    expect(
      shouldRetryMissingAssistantTurn({
        ...state,
        attempt: makeEmbeddedRunnerAttempt({
          toolMetas: [{ toolName: "image_generate", asyncStarted: true }],
        }),
      }),
    ).toBe(false);
    expect(
      shouldRetryMissingAssistantTurn({
        ...state,
        attempt: makeEmbeddedRunnerAttempt({
          itemLifecycle: { startedCount: 1, completedCount: 0, activeCount: 1 },
        }),
      }),
    ).toBe(false);
  });

  const payloadCases: Array<[string, Attempt, number, string | null]> = [
    [
      "tool-use after pre-tool text (#76477)",
      {
        assistantTexts: ["Let me update the file..."],
        toolMetas: [{ toolName: "write" }],
        lastAssistant: assistant({
          stopReason: "toolUse",
          content: [
            { type: "text", text: "Let me update the file..." },
            { type: "toolCall", id: "tool_1", name: "write", arguments: {} },
          ],
        }),
      },
      1,
      "verify before retrying",
    ],
    [
      "unsigned thinking only (#89787)",
      {
        lastAssistant: assistant({ content: thinking() }),
      },
      1,
      "couldn't generate a response",
    ],
    [
      "unsigned thinking with visible text",
      {
        assistantTexts: ["Here is the answer."],
        lastAssistant: assistant({
          content: [...thinking(), { type: "text", text: "Here is the answer." }],
        }),
      },
      1,
      null,
    ],
    [
      "errored signed thinking only",
      {
        lastAssistant: assistant({ stopReason: "error", content: thinking("signed") }),
      },
      1,
      "couldn't generate a response",
    ],
    ...["", "Partial answer"].map((text): [string, Attempt, number, string | null] => [
      `token-limited answer: ${text}`,
      {
        assistantTexts: text ? [text] : [],
        lastAssistant: assistant({ stopReason: "length", content: [{ type: "text", text }] }),
      },
      text ? 1 : 0,
      text ? null : "couldn't generate a response",
    ]),
  ];
  it.each(payloadCases)("resolves warning for %s", (_name, attempt, payloadCount, expected) => {
    const result = warning(attempt, { payloadCount });
    if (expected === null) {
      expect(result).toBeNull();
    } else {
      expect(result).toContain(expected);
    }
  });
});
