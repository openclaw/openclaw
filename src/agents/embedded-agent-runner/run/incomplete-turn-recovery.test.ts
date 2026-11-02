import { describe, expect, it } from "vitest";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { createZeroUsageFixture } from "../../test-helpers/usage-fixtures.js";
import {
  resolveNonVisibleTurnRetryInstructions,
  shouldTreatEmptyAssistantReplyAsSilent,
} from "./incomplete-turn-recovery.js";
import { resolveIncompleteTurnPayloadText } from "./incomplete-turn-resolution.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

const EMPTY_RESPONSE_RETRY_INSTRUCTION =
  "Your turn ended without a final reply. If the user still needs a reply, write it now. If your completed actions already answered the request, answer exactly NO_REPLY. Continue from the current state; do not restart from scratch.";
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

function turnState(
  attempt: Parameters<typeof resolveNonVisibleTurnRetryInstructions>[0]["attempt"] = emptyAttempt(),
) {
  return { payloadCount: 0, aborted: false, timedOut: false, attempt };
}

function retryInstructions(
  overrides: Partial<Parameters<typeof resolveNonVisibleTurnRetryInstructions>[0]> = {},
) {
  return resolveNonVisibleTurnRetryInstructions({
    ...turnState(overrides.attempt),
    settledToolPayloadCount: 0,
    replyDeliveryState: "missing",
    ...overrides,
  });
}

function isSilent(
  attempt: EmbeddedRunAttemptResult,
  terminalReplyExpectation: "required" | "optional" = "optional",
) {
  return shouldTreatEmptyAssistantReplyAsSilent({
    ...turnState(attempt),
    allowEmptyAssistantReplyAsSilent: true,
    terminalReplyExpectation,
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
      retryInstructions({
        modelApi: "openai-completions",
        attempt: emptyAttempt(assistant),
      })[0],
    ).toBeNull();
  });

  it.each([
    { terminalReplyExpectation: "required", owner: "unfinished lifecycle item" },
    { terminalReplyExpectation: "optional", owner: "async tool" },
    { terminalReplyExpectation: "optional", owner: "active lifecycle item" },
    { terminalReplyExpectation: "optional", owner: "unfinished lifecycle item" },
  ] as const)(
    "honors silence without cancelling $owner (reply=$terminalReplyExpectation)",
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
      const state = turnState(attempt);
      // Outward silence does not prove delivery or authorize replaying pending work.
      expect(isSilent(attempt, terminalReplyExpectation)).toBe(true);
      expect(retryInstructions(state)[1]).toBeNull();
      expect(payloadText(attempt)).toBeNull();
    },
  );

  it.each([
    { name: "visible terminal stop", text: "The final answer.", stopReason: "stop" },
    { name: "failed terminal sentinel", text: "NO_REPLY", stopReason: "error" },
    { name: "media-bearing sentinel", text: "NO_REPLY\nMEDIA:/tmp/image.png", stopReason: "stop" },
    { name: "aborted terminal sentinel", text: "NO_REPLY", stopReason: "aborted" },
  ] as const)("does not revive earlier silence after $name", ({ text, stopReason }) => {
    const assistant = emptyAssistant({ content: [{ type: "text", text }], stopReason });
    const attempt = emptyAttempt(assistant);
    attempt.assistantTexts = ["NO_REPLY"];
    expect(isSilent(attempt)).toBe(false);
    if (stopReason === "error") {
      expect(payloadText(attempt)).toBe("No answer was returned. Ask again if you still need one.");
    }
  });

  it("does not treat a tool-call preamble as a silent final", () => {
    const assistant = emptyAssistant({
      stopReason: "toolUse",
      content: [
        { type: "text", text: "NO_REPLY" },
        { type: "toolCall", id: "send", name: "message", arguments: {} },
      ],
    });
    expect(
      shouldTreatEmptyAssistantReplyAsSilent({
        ...turnState(emptyAttempt(assistant)),
        terminalReplyExpectation: "optional",
      }),
    ).toBe(false);
  });

  it.each([
    ["anthropic", "claude-opus-4.7", "messages"],
    ["google-vertex", "google/gemini-3.1-flash", undefined],
  ] as const)(
    "returns the visible-answer prompt for an empty %s turn",
    (provider, modelId, modelApi) => {
      const assistant = emptyAssistant({
        provider,
        model: provider === "google-vertex" ? "gemini-3.1-flash" : modelId,
        content: provider === "anthropic" ? [] : [{ type: "text", text: "" }],
        usage: createZeroUsageFixture(),
      });
      expect(
        retryInstructions({
          provider,
          modelId,
          modelApi,
          attempt: emptyAttempt(assistant),
        })[1],
      ).toBe(EMPTY_RESPONSE_RETRY_INSTRUCTION);
    },
  );

  it("does not retry an empty turn after side effects", () => {
    const assistant = emptyAssistant({ stopReason: "stop", model: "gpt-5.4" });
    const attempt = emptyAttempt(assistant);
    attempt.replayMetadata = { hadPotentialSideEffects: true, replaySafe: false };

    expect(retryInstructions({ provider: "openai", modelId: "gpt-5.4", attempt })[1]).toBeNull();
  });

  it("returns the reasoning continuation for Kimi Anthropic reasoning-only output", () => {
    const assistant = buildEmbeddedRunnerAssistant({
      api: "anthropic-messages",
      provider: "kimi",
      model: "kimi-for-coding",
      content: [{ type: "thinking", thinking: "internal reasoning", thinkingSignature: "" }],
    });

    expect(
      retryInstructions({
        provider: "kimi",
        modelId: "kimi-for-coding",
        modelApi: "anthropic-messages",
        attempt: emptyAttempt(assistant),
      })[0],
    ).toBe(REASONING_ONLY_RETRY_INSTRUCTION);
  });
});

function payloadText(attempt: EmbeddedRunAttemptResult, payloadCount = 0) {
  return resolveIncompleteTurnPayloadText({
    ...turnState(attempt),
    payloadCount,
    externalAbort: false,
  });
}
