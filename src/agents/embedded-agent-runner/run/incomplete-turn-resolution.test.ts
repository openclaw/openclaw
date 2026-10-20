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

function payloadText(
  attempt: Parameters<typeof resolveIncompleteTurnPayloadText>[0]["attempt"],
  payloadCount = 0,
) {
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
  // A `canDeliverSourceReply` tool wrote the final answer; the host delivers it, so a
  // tool-use stop with no post-tool assistant text is not an incomplete turn.
  it("does not let an earlier authored reply complete an unfinished later input", () => {
    const assistant = buildEmbeddedRunnerAssistant({
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "later-call", name: "read", arguments: {} }],
    });
    const result = payloadText(
      makeEmbeddedRunnerAttempt({
        lastAssistant: assistant,
        sourceReplyDeliveryState: "missing",
        messagingToolSourceReplyPayloads: [
          {
            text: "Earlier answer.",
            sourceReplyFinal: true,
            toolAuthored: true,
            toolAuthoredForToolCallId: "earlier-call",
          },
        ],
      }),
      1,
    );
    expect(result).toBe("No answer was returned. Ask again if you still need one.");
  });

  it("treats a final tool-authored source reply as a complete tool-use turn", () => {
    expect(
      payloadText(
        makeEmbeddedRunnerAttempt({
          assistantTexts: [],
          toolMetas: [{ toolName: "order_status", meta: "orderId=SO1" }],
          // A live run starts with no source reply delivered yet.
          sourceReplyDeliveryState: "missing",
          messagingToolSourceReplyPayloads: [
            {
              text: "Pedido SO1 creado.",
              sourceReplyFinal: true,
              toolAuthored: true,
              toolAuthoredForToolCallId: "tool_1",
            },
          ],
          lastAssistant: buildEmbeddedRunnerAssistant({
            stopReason: "toolUse",
            content: [
              {
                type: "toolCall",
                id: "tool_1",
                name: "order_status",
                arguments: { orderId: "SO1" },
              },
            ],
          }),
        }),
        1,
      ),
    ).toBeNull();
  });
});
