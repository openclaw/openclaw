import { describe, expect, it } from "vitest";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import {
  resolveIncompleteTurnPayloadText,
  resolveReplayInvalidFlag,
  resolveRunLivenessState,
} from "./incomplete-turn-resolution.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

function payloadText(attempt: EmbeddedRunAttemptResult, payloadCount = 0) {
  return resolveIncompleteTurnPayloadText({
    payloadCount,
    aborted: false,
    externalAbort: false,
    timedOut: false,
    attempt,
  });
}

function refusalAttempt(provider: string, replaySafe: boolean) {
  const assistant = buildEmbeddedRunnerAssistant({
    provider,
    stopReason: "error",
    diagnostics: [
      { type: "provider_refusal", timestamp: 0, details: { provider, category: "cyber" } },
    ],
  });
  return makeEmbeddedRunnerAttempt({
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
    replayMetadata: { hadPotentialSideEffects: !replaySafe, replaySafe },
  });
}

describe("incomplete-turn terminal metadata", () => {
  it("accepts a completed speech-only answer with provider reasoning", () => {
    const assistant = buildEmbeddedRunnerAssistant({
      content: [
        { type: "thinking", thinking: "Prepare a spoken greeting.", thinkingSignature: "" },
        { type: "text", text: "" },
      ],
      openclawDelivery: { tts: { tagged: true, text: "Have a lovely day." } },
    });
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: [],
      currentAttemptAssistant: assistant,
      currentAttemptCompletedAssistant: assistant,
    });

    expect(payloadText(attempt, 1)).toBeNull();
  });

  it("keeps the side-effect warning when the terminal error is a provider refusal", () => {
    const attempt = refusalAttempt("anthropic", false);

    expect(payloadText(attempt)).toBe(
      "No answer was returned. Ask again if you still need one. Note: some tool actions may have already been executed — please verify before retrying.",
    );
  });

  it("keeps an explicitly replay-safe structured provider refusal replayable", () => {
    const attempt = refusalAttempt("openai", true);
    const incompleteTurnText = payloadText(attempt);

    expect(incompleteTurnText).toContain("provider refused this request");
    expect(resolveReplayInvalidFlag({ attempt, incompleteTurnText })).toBe(false);
  });

  it("keeps completed tool-use evidence incomplete when the current transcript slice is absent", () => {
    const assistant = buildEmbeddedRunnerAssistant({ stopReason: "toolUse" });
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: ["Let me update the file..."],
      toolMetas: [{ toolName: "write" }],
      lastAssistant: assistant,
      currentAttemptAssistant: undefined,
      currentAttemptCompletedAssistant: assistant,
    });

    expect(payloadText(attempt, 1)).toBe(
      "No answer was returned. Ask again if you still need one. Note: some tool actions may have already been executed — please verify before retrying.",
    );
  });

  it("does not treat a tool result token as an assistant final", () => {
    const attempt = makeEmbeddedRunnerAttempt({
      toolMetas: [{ toolName: "exec" }],
      messagesSnapshot: [
        {
          role: "toolResult",
          content: [{ type: "text", text: "NO_REPLY" }],
          details: { aggregated: "NO_REPLY" },
        } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
      ],
    });
    expect(payloadText(attempt)).not.toBeNull();
  });

  it("marks compaction-timeout retries as paused and replay-invalid", () => {
    const attempt = makeEmbeddedRunnerAttempt({
      terminal: { kind: "timeout", phase: "compaction", source: "runtime" },
    });

    expect(resolveReplayInvalidFlag({ attempt })).toBe(true);
    expect(
      resolveRunLivenessState({
        payloadCount: 0,
        aborted: true,
        timedOut: true,
        attempt,
      }),
    ).toBe("paused");
  });
});

describe("tool-authored source replies", () => {
  it.each([
    [
      "earlier-call",
      "later-call",
      "read",
      "Earlier answer.",
      undefined,
      "No answer was returned. Ask again if you still need one.",
    ],
    [
      "tool_1",
      "tool_1",
      "order_status",
      "Pedido SO1 creado.",
      [{ toolName: "order_status", meta: "orderId=SO1" }],
      null,
    ],
  ] as const)(
    "only completes the owning tool-use turn (%s / %s)",
    (replyId, callId, name, text, toolMetas, expected) => {
      const assistant = buildEmbeddedRunnerAssistant({
        stopReason: "toolUse",
        content: [
          {
            type: "toolCall",
            id: callId,
            name,
            arguments: name === "order_status" ? { orderId: "SO1" } : {},
          },
        ],
      });
      const attempt = makeEmbeddedRunnerAttempt({
        lastAssistant: assistant,
        sourceReplyDeliveryState: "missing",
        ...(toolMetas ? { assistantTexts: [], toolMetas: [...toolMetas] } : {}),
        messagingToolSourceReplyPayloads: [
          {
            text,
            sourceReplyFinal: true,
            toolAuthored: true,
            toolAuthoredForToolCallId: replyId,
          },
        ],
      });
      expect(payloadText(attempt, 1)).toBe(expected);
    },
  );
});
