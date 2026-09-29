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

  it("retries replay-safe errored turns that only emitted thinking blocks", () => {
    expect(retryError({ errorMessage: undefined, content: thinking("signed") })).toBe(true);
  });

  it.each([
    { errorMessage: REJECTION },
    { errorMessage: "Provider rejected the tool call", errorCode: "malformed_tool_call_arguments" },
  ])("retries positive-output pre-dispatch rejection: %j", (rejection) => {
    expect(retryError(rejection)).toBe(true);
  });

  it.each([
    { errorMessage: `${REJECTION} after dispatch` },
    {
      errorMessage: "Provider rejected the tool call",
      errorCode: "malformed_tool_call_arguments_suffix",
    },
  ])("refuses non-exact rejection evidence: %j", (rejection) => {
    expect(retryError(rejection)).toBe(false);
  });

  it.each([
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
  ] satisfies Partial<Assistant>[])("preserves terminal rejection evidence: %j", (rejection) => {
    expect(retryError(rejection)).toBe(false);
  });

  it.each([
    ["visible text", { assistantTexts: ["Applying the edit now."] }],
    ["accepted client call", { clientToolCalls: [{ name: "pending", params: {} }] }],
    ["asynchronous work", { toolMetas: [{ toolName: "probe", asyncStarted: true }] }],
  ] satisfies Array<[string, Attempt]>)(
    "refuses a pre-dispatch rejection after %s",
    (_name, attempt) => {
      expect(retryError({}, attempt)).toBe(false);
    },
  );

  it("does not retry an errored turn containing a tool call", () => {
    expect(
      retryError({
        content: [
          ...thinking("signed"),
          { type: "toolCall", id: "call_1", name: "read", arguments: { path: "README.md" } },
        ],
      }),
    ).toBe(false);
  });

  it.each([
    ["current clean overrides cumulative dirty", true, false, true],
    ["current dirty overrides cumulative clean", false, true, false],
  ] as const)(
    "uses current-attempt replay metadata when %s",
    (_name, cumulative, current, expected) => {
      expect(
        retryError(
          { errorMessage: undefined, usage: createMockUsage(100, 0) },
          {
            replayMetadata: { hadPotentialSideEffects: cumulative, replaySafe: !cumulative },
            currentAttemptReplayMetadata: {
              hadPotentialSideEffects: current,
              replaySafe: !current,
            },
          },
        ),
      ).toBe(expected);
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

  it("treats committed messaging targets as replay-invalid side effect metadata", () => {
    expect(
      buildAttemptReplayMetadata({
        toolMetas: [],
        didSendViaMessagingTool: false,
        messagingToolSentTexts: [],
        messagingToolSentMediaUrls: [],
        messagingToolSentTargets: [{ tool: "message", provider: "slack", to: "channel-1" }],
      }),
    ).toEqual({ hadPotentialSideEffects: true, replaySafe: false });
  });

  it("treats accepted sessions_spawn as replay-invalid outbound delivery", () => {
    const acceptedSessionSpawns = [
      { runId: "child", childSessionKey: "agent:test:subagent:child" },
    ];
    expect(
      buildAttemptReplayMetadata({
        toolMetas: [],
        didSendViaMessagingTool: false,
        messagingToolSentTexts: [],
        messagingToolSentMediaUrls: [],
        acceptedSessionSpawns,
      }),
    ).toEqual({ hadPotentialSideEffects: true, replaySafe: false });
    expect(hasOutboundDeliveryEvidence({ acceptedSessionSpawns })).toBe(true);
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

  it("surfaces tool-use terminal with pre-tool text and side effects as replay-unsafe (#76477)", () => {
    expect(
      warning(
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
        { payloadCount: 1 },
      ),
    ).toContain("verify before retrying");
  });

  it("surfaces unsigned thinking without a visible answer even when payloadCount is one (#89787)", () => {
    expect(
      warning({ lastAssistant: assistant({ content: thinking() }) }, { payloadCount: 1 }),
    ).toContain("couldn't generate a response");
  });

  it("does not surface a stall when unsigned thinking accompanies visible text", () => {
    expect(
      warning(
        {
          assistantTexts: ["Here is the answer."],
          lastAssistant: assistant({
            content: [...thinking(), { type: "text", text: "Here is the answer." }],
          }),
        },
        { payloadCount: 1 },
      ),
    ).toBeNull();
  });

  it("surfaces an errored signed-thinking-only turn even when payloadCount is one", () => {
    expect(
      warning(
        { lastAssistant: assistant({ stopReason: "error", content: thinking("signed") }) },
        { payloadCount: 1 },
      ),
    ).toContain("couldn't generate a response");
  });

  it.each(["", "Partial answer"])(
    "keeps token-limited answers deliverable only with visible text: %s",
    (text) => {
      const result = warning(
        {
          assistantTexts: text ? [text] : [],
          lastAssistant: assistant({ stopReason: "length", content: [{ type: "text", text }] }),
        },
        { payloadCount: text ? 1 : 0 },
      );
      if (text) {
        expect(result).toBeNull();
      } else {
        expect(result).toContain("couldn't generate a response");
      }
    },
  );
});
