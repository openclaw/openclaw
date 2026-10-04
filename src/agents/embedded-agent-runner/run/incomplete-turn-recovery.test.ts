import { describe, expect, it } from "vitest";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { createZeroUsageFixture } from "../../test-helpers/usage-fixtures.js";
import {
  resolveEmptyResponseRetryInstruction,
  resolveReasoningOnlyRetryInstruction,
  shouldTreatEmptyAssistantReplyAsSilent,
} from "./incomplete-turn-recovery.js";
import { resolveIncompleteTurnPayloadText } from "./incomplete-turn-resolution.js";

const EMPTY_RESPONSE_RETRY_INSTRUCTION =
  "The previous attempt did not produce a user-visible answer. Continue from the current state and produce the visible answer now. Do not restart from scratch.";
const REASONING_ONLY_RETRY_INSTRUCTION =
  "The previous assistant turn recorded reasoning but did not produce a user-visible answer. Continue from that partial turn and produce the visible answer now. Do not restate the reasoning or restart from scratch.";

function emptyAssistant(overrides: Parameters<typeof buildEmbeddedRunnerAssistant>[0] = {}) {
  return buildEmbeddedRunnerAssistant({
    content: [{ type: "text", text: "" }],
    ...overrides,
  });
}

function emptyAttempt(assistant = emptyAssistant()) {
  return makeEmbeddedRunnerAttempt({
    assistantTexts: [],
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
    currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
  });
}

describe("incomplete-turn recovery policy", () => {
  it("does not request a visible continuation for an authored speech-only answer", () => {
    const assistant = emptyAssistant({
      content: [
        { type: "thinking", thinking: "Prepare a spoken greeting.", thinkingSignature: "" },
        { type: "text", text: "" },
      ],
      openclawDelivery: { tts: { tagged: true, text: "Have a lovely day." } },
    });

    expect(
      resolveReasoningOnlyRetryInstruction({
        modelApi: "openai-completions",
        aborted: false,
        timedOut: false,
        attempt: emptyAttempt(assistant),
      }),
    ).toBeNull();
  });

  it.each([
    { terminalReplyExpectation: "required", owner: "unfinished lifecycle item" },
    { terminalReplyExpectation: "optional", owner: "async tool" },
    { terminalReplyExpectation: "optional", owner: "active lifecycle item" },
    { terminalReplyExpectation: "optional", owner: "unfinished lifecycle item" },
  ] as const)(
    "keeps $owner out of completed silence (reply=$terminalReplyExpectation)",
    ({ terminalReplyExpectation, owner }) => {
      const assistant = emptyAssistant({ content: [{ type: "text", text: "NO_REPLY" }] });
      const attempt = makeEmbeddedRunnerAttempt({
        assistantTexts: ["NO_REPLY"],
        lastAssistant: assistant,
        currentAttemptAssistant: assistant,
        toolMetas: [
          { toolName: "image_generate", asyncStarted: owner === "async tool", replaySafe: false },
        ],
        itemLifecycle: {
          startedCount: 1,
          completedCount: owner === "async tool" ? 1 : 0,
          activeCount: owner === "active lifecycle item" ? 1 : 0,
        },
        replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
        currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
      });
      const state = { payloadCount: 0, aborted: false, timedOut: false, attempt };
      // Silence must not steal completion ownership from background work. Nor
      // may it trigger a replay or a spurious warning while that owner continues.
      expect(
        shouldTreatEmptyAssistantReplyAsSilent({
          ...state,
          allowEmptyAssistantReplyAsSilent: true,
          terminalReplyExpectation,
        }),
      ).toBe(false);
      expect(resolveEmptyResponseRetryInstruction(state)).toBeNull();
      expect(resolveIncompleteTurnPayloadText({ ...state, externalAbort: false })).toBeNull();
    },
  );

  it.each([
    { name: "visible terminal stop", text: "The final answer.", stopReason: "stop" },
    { name: "failed terminal sentinel", text: "NO_REPLY", stopReason: "error" },
    { name: "aborted terminal sentinel", text: "NO_REPLY", stopReason: "aborted" },
  ] as const)("does not revive earlier silence after $name", ({ text, stopReason }) => {
    const assistant = emptyAssistant({ content: [{ type: "text", text }], stopReason });
    const attempt = emptyAttempt(assistant);
    attempt.assistantTexts = ["NO_REPLY"];
    expect(
      shouldTreatEmptyAssistantReplyAsSilent({
        allowEmptyAssistantReplyAsSilent: true,
        terminalReplyExpectation: "optional",
        payloadCount: 0,
        aborted: false,
        timedOut: false,
        attempt,
      }),
    ).toBe(false);
    if (stopReason === "error") {
      expect(
        resolveIncompleteTurnPayloadText({
          payloadCount: 0,
          aborted: false,
          externalAbort: false,
          timedOut: false,
          attempt,
        }),
      ).toContain("couldn't generate a response");
    }
  });

  it.each([
    {
      name: "zero-token Anthropic stop",
      provider: "anthropic",
      modelId: "claude-opus-4.7",
      modelApi: "messages",
      assistant: buildEmbeddedRunnerAssistant({
        provider: "anthropic",
        model: "claude-opus-4.7",
        content: [],
        usage: createZeroUsageFixture(),
      }),
    },
    {
      name: "generic empty Gemini turn",
      provider: "google-vertex",
      modelId: "google/gemini-3.1-flash",
      modelApi: undefined,
      assistant: emptyAssistant({
        stopReason: "stop",
        provider: "google-vertex",
        model: "gemini-3.1-flash",
      }),
    },
  ])(
    "returns the visible-answer prompt for $name",
    ({ provider, modelId, modelApi, assistant }) => {
      expect(
        resolveEmptyResponseRetryInstruction({
          provider,
          modelId,
          modelApi,
          payloadCount: 0,
          aborted: false,
          timedOut: false,
          attempt: emptyAttempt(assistant),
        }),
      ).toBe(EMPTY_RESPONSE_RETRY_INSTRUCTION);
    },
  );

  it("does not retry an empty turn after side effects", () => {
    const assistant = emptyAssistant({ stopReason: "stop", model: "gpt-5.4" });
    const attempt = emptyAttempt(assistant);
    attempt.replayMetadata = { hadPotentialSideEffects: true, replaySafe: false };

    expect(
      resolveEmptyResponseRetryInstruction({
        provider: "openai",
        modelId: "gpt-5.4",
        payloadCount: 0,
        aborted: false,
        timedOut: false,
        attempt,
      }),
    ).toBeNull();
  });

  it("returns the reasoning continuation for Kimi Anthropic reasoning-only output", () => {
    const assistant = buildEmbeddedRunnerAssistant({
      api: "anthropic-messages",
      provider: "kimi",
      model: "kimi-for-coding",
      content: [{ type: "thinking", thinking: "internal reasoning", thinkingSignature: "" }],
    });

    expect(
      resolveReasoningOnlyRetryInstruction({
        provider: "kimi",
        modelId: "kimi-for-coding",
        modelApi: "anthropic-messages",
        aborted: false,
        timedOut: false,
        attempt: emptyAttempt(assistant),
      }),
    ).toBe(REASONING_ONLY_RETRY_INSTRUCTION);
  });

  it.each([
    { name: "a collected collector", spawns: [{ runId: "run-a", collected: true }], silent: true },
    { name: "an uncollected collector", spawns: [{ runId: "run-a" }], silent: false },
    {
      name: "one of two collectors collected",
      spawns: [{ runId: "run-a", collected: true }, { runId: "run-b" }],
      silent: false,
    },
    {
      name: "a completion-message child",
      spawns: [{ runId: "run-a", collected: true, expectsCompletionMessage: true }],
      silent: false,
    },
  ] as const)("classifies optional NO_REPLY after $name", ({ spawns, silent }) => {
    const assistant = emptyAssistant({ content: [{ type: "text", text: "NO_REPLY" }] });
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: ["NO_REPLY"],
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
      toolMetas: [
        ...spawns.map(() => ({ toolName: "sessions_spawn", replaySafe: false })),
        { toolName: "agents_wait", replaySafe: true },
      ],
      acceptedSessionSpawns: spawns.map((spawn) => ({
        childSessionKey: `agent:main:subagent:${spawn.runId}`,
        expectsCompletionMessage: false,
        ...spawn,
      })),
      replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
      currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
    });
    const state = { payloadCount: 0, aborted: false, timedOut: false, attempt };

    expect(
      shouldTreatEmptyAssistantReplyAsSilent({ ...state, terminalReplyExpectation: "optional" }),
    ).toBe(silent);
    expect(
      shouldTreatEmptyAssistantReplyAsSilent({ ...state, terminalReplyExpectation: "required" }),
    ).toBe(false);
  });
});
