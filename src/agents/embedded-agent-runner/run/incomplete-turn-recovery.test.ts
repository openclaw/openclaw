import { describe, expect, it } from "vitest";
import {
  RECOVERY_REPLY_DELIVERY_CONTRACT,
  SETTLED_TOOL_TERMINAL_CONTINUATION_BODY,
  isRecoveryInstructionEcho,
} from "../../recovery-nudge-text.js";
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

const EMPTY_RESPONSE_RETRY_INSTRUCTION = `Your turn ended without a final reply. If the user still needs a reply, write it now. If your completed actions already answered the request, answer exactly NO_REPLY. Continue from the current state; do not restart from scratch. ${RECOVERY_REPLY_DELIVERY_CONTRACT}`;
const REASONING_ONLY_RETRY_INSTRUCTION = `The previous assistant turn recorded reasoning but did not produce a user-visible answer. Continue from that partial turn and produce the visible answer now. Do not restate the reasoning or restart from scratch. ${RECOVERY_REPLY_DELIVERY_CONTRACT}`;

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
      const state = { payloadCount: 0, aborted: false, timedOut: false, attempt };
      // Outward silence does not prove delivery or authorize replaying pending work.
      expect(
        shouldTreatEmptyAssistantReplyAsSilent({
          ...state,
          allowEmptyAssistantReplyAsSilent: true,
          terminalReplyExpectation,
        }),
      ).toBe(true);
      expect(
        resolveEmptyResponseRetryInstruction({ ...state, replyDeliveryState: "missing" }),
      ).toBeNull();
      expect(resolveIncompleteTurnPayloadText({ ...state, externalAbort: false })).toBeNull();
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
      ).toBe("No answer was returned. Ask again if you still need one.");
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
        terminalReplyExpectation: "optional",
        payloadCount: 0,
        aborted: false,
        timedOut: false,
        attempt: emptyAttempt(assistant),
      }),
    ).toBe(false);
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
          replyDeliveryState: "missing",
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
        replyDeliveryState: "missing",
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
    ["the empty-response nudge", EMPTY_RESPONSE_RETRY_INSTRUCTION],
    ["the reasoning-only nudge", REASONING_ONLY_RETRY_INSTRUCTION],
  ])("flags a reply that restates %s", (_label, instruction) => {
    expect(isRecoveryInstructionEcho(`Let me plan this out. ${instruction}`)).toBe(true);
  });

  it("keeps a reply that shares only one sentence of the nudge wording", () => {
    expect(
      isRecoveryInstructionEcho(
        "Wait, the system says: The previous attempt did not produce a user-visible answer, so I must answer now.",
      ),
    ).toBe(false);
    // A genuine answer can open with the nudge's first sentence and still
    // deliver the requested result; a single shared passage is not an echo.
    expect(
      isRecoveryInstructionEcho(
        "The previous attempt did not produce a user-visible answer because the provider stopped early. The disk has 12 GB free.",
      ),
    ).toBe(false);
  });

  it("matches only the instruction that was actually injected", () => {
    expect(
      isRecoveryInstructionEcho(
        "The previous assistant turn stopped for tool use but contained no tool call, so nothing ran. Continue from the current state: call the tool you need.",
        EMPTY_RESPONSE_RETRY_INSTRUCTION,
      ),
    ).toBe(false);
    expect(
      isRecoveryInstructionEcho(
        `Let me plan this out. ${EMPTY_RESPONSE_RETRY_INSTRUCTION}`,
        EMPTY_RESPONSE_RETRY_INSTRUCTION,
      ),
    ).toBe(true);
  });

  it("flags the delivery contract when the reply restates it", () => {
    expect(isRecoveryInstructionEcho(`Understood. ${RECOVERY_REPLY_DELIVERY_CONTRACT}`)).toBe(true);
  });

  it("keeps an answer that only reuses one generic run of the wording", () => {
    expect(
      isRecoveryInstructionEcho(
        "The previous attempt did not complete because the process was killed, so I retried and it finished.",
      ),
    ).toBe(false);
    expect(
      isRecoveryInstructionEcho(
        "I finished the tool calls but did not produce a summary in the previous step, so I wrote one now.",
      ),
    ).toBe(false);
    expect(
      isRecoveryInstructionEcho(
        "The previous assistant turn completed the migration before the logs rolled over.",
      ),
    ).toBe(false);
  });

  it("keeps a short fragment of a nudge quoted inside planning", () => {
    expect(
      isRecoveryInstructionEcho(
        'the system says "Continue from the current transcript" so here goes',
      ),
    ).toBe(false);
    expect(isRecoveryInstructionEcho("Do not restart from scratch.")).toBe(false);
  });

  it("keeps a substantive answer that quotes part of the injected instruction", () => {
    expect(
      isRecoveryInstructionEcho(
        'The log says "Continue from the current transcript. Do not repeat completed tool calls or restart from scratch." The disk has 12 GB free; nothing needs cleanup.',
        SETTLED_TOOL_TERMINAL_CONTINUATION_BODY,
      ),
    ).toBe(false);
  });

  it("flags repeated copies of the complete injected instruction", () => {
    expect(
      isRecoveryInstructionEcho(
        `${SETTLED_TOOL_TERMINAL_CONTINUATION_BODY} ${SETTLED_TOOL_TERMINAL_CONTINUATION_BODY}`,
        SETTLED_TOOL_TERMINAL_CONTINUATION_BODY,
      ),
    ).toBe(true);
  });

  it("keeps planning prose and a plain answer", () => {
    expect(
      isRecoveryInstructionEcho(
        "I continued from the current state and produced the final answer after checking the logs.",
      ),
    ).toBe(false);
    expect(isRecoveryInstructionEcho("Nothing needs cleanup; the disk has 12 GB free.")).toBe(
      false,
    );
    expect(isRecoveryInstructionEcho("")).toBe(false);
  });
});
