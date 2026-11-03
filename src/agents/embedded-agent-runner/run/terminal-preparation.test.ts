import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
} from "../../../auto-reply/reply-payload.js";
import { createTestAdmittedRunContext } from "../../admitted-run-context.test-support.js";
import {
  markCoreTtsAttemptResult,
  markCoreTtsToolResult,
  transferCoreTtsToolResultProvenance,
} from "../../tools/tts-tool-result-provenance.js";
import { createUsageAccumulator } from "../usage-accumulator.js";
import type { buildEmbeddedRunPayloads } from "./payloads.js";
import {
  assistantMessage,
  attemptResult,
  prepareAttempt,
} from "./terminal-preparation.test-support.js";
function hardTimeoutState(): NonNullable<Parameters<typeof prepareAttempt>[0]["terminalState"]> {
  return {
    outcome: {
      reason: "hard_timeout",
      status: "timeout",
      timeoutPhase: "provider",
      providerStarted: true,
    },
    signalOwnedInterruption: false,
  };
}

function checkingToolTurn(): AssistantMessage {
  return {
    ...assistantMessage("toolUse"),
    content: [
      { type: "text", text: "Checking now" },
      { type: "toolCall", id: "tool_1", name: "exec", arguments: {} },
    ],
  };
}

function textAssistant(text: string, stopReason: AssistantMessage["stopReason"] = "stop") {
  return { ...assistantMessage(stopReason), content: [{ type: "text" as const, text }] };
}

type PreparationInput = Parameters<typeof prepareAttempt>[0];
function prepareAssistant(
  assistant: AssistantMessage,
  attempt: Parameters<typeof attemptResult>[0] = {},
  input: Partial<PreparationInput> = {},
) {
  return prepareAttempt({
    attempt: attemptResult(
      { messagesSnapshot: [assistantMessage("error")], ...attempt },
      assistant,
    ),
    currentAttemptCompletedAssistant: assistant,
    ...input,
  });
}

const payloadMocks = vi.hoisted(() => ({
  buildEmbeddedRunPayloads: vi.fn<typeof buildEmbeddedRunPayloads>(),
}));

vi.mock("./payloads.js", () => ({
  buildEmbeddedRunPayloads: payloadMocks.buildEmbeddedRunPayloads,
}));

describe("prepareEmbeddedRunTerminal", () => {
  it("retains a saved receipt without claiming terminal transcript ownership", async () => {
    const prepared = await prepareAttempt({
      attempt: attemptResult({
        assistantTranscriptOwned: false,
        assistantTranscriptIdempotencyKey: "saved-partial",
      }),
    });
    expect(prepared.agentMeta.terminalReceipt?.assistantTranscriptIdempotencyKey).toBe(
      "saved-partial",
    );
  });
  beforeEach(() => {
    payloadMocks.buildEmbeddedRunPayloads.mockReset().mockReturnValue([]);
  });

  it("keeps an acknowledgement-only user reply aligned with presentation", async () => {
    const payload = { text: "HEARTBEAT_OK" };
    payloadMocks.buildEmbeddedRunPayloads.mockReturnValueOnce([payload]);

    const prepared = await prepareAttempt({
      attempt: attemptResult(),
    });

    expect(prepared.payloadsWithToolMedia).toEqual([payload]);
    expect(prepared.payloadsForVisibleCompletion).toEqual([]);
  });

  it.each([
    ["core-attested delivered media", ["/tmp/reply.opus"], false, undefined, ["/tmp/reply.opus"]],
    ["an external harness field", [], true, undefined, []],
    ["core-attested but non-delivered media", ["/tmp/other.opus"], false, undefined, []],
    ["a transferred core TTS result", [], false, "core", ["/tmp/reply.opus"]],
    ["a transferred plugin result", [], false, "plugin", []],
  ] as const)(
    "accepts only %s for source-suppression delivery",
    async (_, media, forge, transfer, expected) => {
      payloadMocks.buildEmbeddedRunPayloads.mockReturnValueOnce([
        { text: "PRIVATE_FINAL_83636_MUST_NOT_APPEAR" },
      ]);
      const attempt = attemptResult({
        toolMediaUrls: ["/tmp/reply.opus"],
        toolAudioAsVoice: true,
        toolTrustedLocalMedia: true,
      });
      const admittedRunContext = createTestAdmittedRunContext("run-focused");
      if (media.length) {
        markCoreTtsAttemptResult(attempt, [...media], admittedRunContext.operationalRunInstance);
      }
      if (forge) {
        Reflect.set(attempt, "toolAutoDeliveryMediaUrls", ["/tmp/reply.opus"]);
      }
      if (transfer) {
        const toolResult =
          transfer === "core" ? markCoreTtsToolResult({}, ["/tmp/reply.opus"]) : {};
        transferCoreTtsToolResultProvenance(
          toolResult,
          attempt,
          ["/tmp/reply.opus"],
          admittedRunContext.operationalRunInstance,
        );
      }

      const prepared = await prepareAttempt({
        attempt,
        admittedRunContext,
        sourceReplyDeliveryMode: "message_tool_only",
      });
      const markedMedia = (prepared.payloadsWithToolMedia ?? []).filter(
        (payload) =>
          getReplyPayloadMetadata(payload)?.deliverDespiteSourceReplySuppression === true,
      );

      expect(markedMedia.flatMap((payload) => payload.mediaUrls ?? [])).toEqual(expected);
      expect(markedMedia.every((payload) => !payload.text)).toBe(true);
    },
  );

  it.each<[string[], string | undefined, string?]>([
    [["Earlier", "  Latest 😀  ", "\t\r\n"], "Latest 😀", "  Latest 😀  "],
    [["Earlier", "\ufeff\u2003Latest\u00a0", "\u2028"], "Latest", "\ufeff\u2003Latest\u00a0"],
    [["Earlier", " \u200b "], "Earlier"],
    [[" \u200b\u200d\u2060 "], undefined],
    [
      ["  First line \n second line  "],
      "First line \n second line",
      "  First line \n second line  ",
    ],
    [["Earlier", " \ud800text\udc00 "], "\ud800text\udc00", " \ud800text\udc00 "],
    [["", " \t\r\n", "\ufeff\u2003"], undefined],
    [[], undefined],
  ])(
    "selects final fallback text without changing its source %#",
    async (assistantTexts, expected, expectedRaw = expected) => {
      const original = [...assistantTexts];
      const prepared = await prepareAttempt({
        attempt: attemptResult({
          assistantTexts,
          messagesSnapshot: [],
          lastAssistant: undefined,
          currentAttemptAssistant: undefined,
          currentAttemptCompletedAssistant: undefined,
        }),
      });

      expect(prepared.finalAssistantVisibleText).toBe(expected ?? "");
      expect(prepared.finalAssistantRawText).toBe(expectedRaw);
      expect(assistantTexts).toEqual(original);
    },
  );

  it.each([
    { stopReason: "stop", thinking: false, keepAnswer: false },
    { stopReason: "length", thinking: true, keepAnswer: false },
    { stopReason: "stop", thinking: false, keepAnswer: true },
  ] as const)(
    "keeps pre-tool text out of empty $stopReason terminal metadata (thinking=$thinking, kept=$keepAnswer)",
    async ({ stopReason, thinking, keepAnswer }) => {
      const terminal: AssistantMessage = {
        ...assistantMessage(stopReason),
        api: "ollama",
        provider: "ollama",
        content: thinking ? [{ type: "thinking", thinking: "Considering the file." }] : [],
      };
      const keptAnswer = {
        assistant: textAssistant("Completed answer."),
        messageIndex: 1,
      };
      const prepared = await prepareAssistant(
        terminal,
        {
          assistantTexts: ["I will read the file."],
          toolMetas: [{ toolName: "read" }],
          messagesSnapshot: [terminal],
          keptAnswer: keepAnswer ? keptAnswer : undefined,
        },
        {
          terminalState: {
            outcome: { reason: "completed", status: "ok", stopReason },
            signalOwnedInterruption: false,
          },
        },
      );
      const expected = keepAnswer ? "Completed answer." : undefined;
      expect(prepared.finalAssistantVisibleText).toBe(expected ?? "");
      expect(prepared.finalAssistantRawText).toBe(expected);
    },
  );

  it.each(["empty final", "completed tool call", "later partial", "own final"])(
    "keeps model diagnostics scoped to the %s",
    async (kind) => {
      const text = kind === "later partial" ? "Here is the partial answer" : "Done";
      const assistant =
        kind === "empty final"
          ? { ...assistantMessage(), content: [] }
          : kind === "completed tool call"
            ? checkingToolTurn()
            : textAssistant(text, kind === "later partial" ? "aborted" : "stop");
      const completed = kind === "later partial" ? checkingToolTurn() : assistant;
      const prepared = await prepareAssistant(completed, {
        assistantTexts: [
          "Checking now",
          ...(kind === "later partial" || kind === "own final" ? [text] : []),
        ],
        lastAssistant: assistant,
        currentAttemptAssistant: assistant,
      });
      expect(prepared.finalAssistantMessageRawText).toBe(
        kind === "later partial" || kind === "own final" ? text : "",
      );
      if (kind === "empty final" || kind === "own final") {
        expect(prepared.finalAssistantRawText).toBe(kind === "own final" ? text : undefined);
      }
    },
  );

  it.each(["error", "aborted"] as const)(
    "does not use %s assistant text as final terminal text",
    async (stopReason) => {
      const assistant = assistantMessage(stopReason);
      const prepared = await prepareAssistant(
        assistant,
        {},
        {
          terminalState: {
            outcome:
              stopReason === "aborted"
                ? { reason: "aborted", status: "error", stopReason }
                : { reason: "failed", status: "error", stopReason, error: "provider failed" },
            signalOwnedInterruption: false,
          },
        },
      );

      expect(prepared.finalAssistantVisibleText).toBe("");
      expect(prepared.finalAssistantRawText).toBeUndefined();
    },
  );

  it.each([true, false])(
    "uses current-attempt attribution instead of stale session evidence (completed: %s)",
    async (completed) => {
      const finalText = "The requested update is complete.";
      const nativeSelection = { provider: "native-provider", model: "native-model" };
      const staleAssistant = {
        ...assistantMessage("toolUse"),
        content: [{ type: "toolCall" as const, id: "tool_1", name: "update_plan", arguments: {} }],
      };
      const currentAssistant = {
        ...assistantMessage("stop"),
        ...nativeSelection,
        content: [{ type: "text" as const, text: finalText }],
        usage: {
          ...assistantMessage("stop").usage,
          input: 200,
          output: 20,
          totalTokens: 220,
        },
      };
      const completedAssistant = completed ? currentAssistant : undefined;
      const prepared = await prepareAttempt({
        attempt: attemptResult({
          assistantTexts: ["Analysis...", finalText],
          toolMetas: [{ toolName: "update_plan" }],
          lastAssistant: staleAssistant,
          currentAttemptAssistant: currentAssistant,
          currentAttemptCompletedAssistant: completedAssistant,
          runtimeModelSelection: nativeSelection,
        }),
        currentAttemptCompletedAssistant: completedAssistant,
      });

      expect(prepared.finalAssistantVisibleText).toBe(finalText);
      expect(prepared.finalAssistantRawText).toBe(finalText);
      expect(prepared.agentMeta).toMatchObject({
        ...nativeSelection,
        runtimeModelSelection: nativeSelection,
      });
      expect(payloadMocks.buildEmbeddedRunPayloads).toHaveBeenCalledWith(
        expect.objectContaining({
          lastAssistant: completedAssistant,
          currentAssistant: completedAssistant ?? null,
        }),
      );
      if (completed) {
        expect(prepared.agentMeta.lastCallUsage).toMatchObject({
          input: 200,
          output: 20,
          total: 220,
        });
      } else {
        expect(prepared.agentMeta.lastCallUsage).toBeUndefined();
      }
    },
  );

  it("keeps legacy CLI aggregates while marking latest context usage unavailable", async () => {
    const assistant = {
      ...assistantMessage("stop"),
      api: "cli",
      usage: {
        input: 128_814,
        output: 3_000,
        cacheRead: 992_953,
        cacheWrite: 0,
        totalTokens: 1_124_767,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    } satisfies AssistantMessage;
    const aggregate = {
      input: 128_814,
      output: 3_000,
      cacheRead: 992_953,
      total: 1_124_767,
    };
    const usageAccumulator = Object.assign(createUsageAccumulator(), aggregate);
    const prepared = await prepareAssistant(
      assistant,
      {},
      {
        usageAccumulator,
        lastRunPromptUsage: { input: 42_000, output: 1_000, total: 43_000 },
      },
    );

    expect(prepared.agentMeta.usage).toEqual(aggregate);
    expect(prepared.agentMeta.lastCallUsage).toEqual({
      contextUsage: { state: "unavailable" },
    });
    expect(prepared.agentMeta.promptTokens).toBeUndefined();
  });

  it("recovers current final text and tool media after a prompt-timeout race", async () => {
    const completedText = "Completed answer block before the timeout.";
    const partialText = "Partial final response before the timeout.";
    const finalText = "Complete final response after the timeout.";
    const finalAssistant = textAssistant(finalText);
    const completedPayload = setReplyPayloadMetadata(
      { text: completedText },
      { assistantMessageIndex: 0 },
    );
    const partialPayload = setReplyPayloadMetadata(
      { text: partialText },
      { assistantMessageIndex: 1 },
    );
    payloadMocks.buildEmbeddedRunPayloads.mockReturnValueOnce([completedPayload, partialPayload]);

    const prepared = await prepareAssistant(
      finalAssistant,
      {
        terminal: { kind: "timeout", phase: "prompt", source: "runtime" },
        assistantTexts: [completedText, partialText],
        toolMediaUrls: ["https://example.test/recovered-output.png"],
      },
      {
        replyDeliveryState: "delivered",
        sourceReplyDeliveryState: "missing",
        terminalState: hardTimeoutState(),
      },
    );

    expect(prepared.hasSuccessfulFinalAssistantAfterPromptTimeout).toBe(true);
    expect(prepared.recoveredFinalAssistantPayloadsAfterPromptTimeout).toEqual([
      expect.objectContaining({
        mediaUrl: "https://example.test/recovered-output.png",
        text: completedText,
      }),
      { text: finalText },
    ]);
    expect(getReplyPayloadMetadata(partialPayload)?.localTranscriptDeliveryConfirmed).toBe(true);
    const [kept, text] = prepared.recoveredFinalAssistantPayloadsAfterPromptTimeout!;
    expect(getReplyPayloadMetadata(kept!)?.localTranscriptDeliveryConfirmed).toBe(true);
    expect(getReplyPayloadMetadata(text!)?.localTranscriptDeliveryConfirmed).toBeUndefined();
  });

  it("does not recover stale session text after the current prompt times out", async () => {
    const staleAssistant = textAssistant("Stale answer from the prior attempt.");

    const prepared = await prepareAttempt({
      attempt: attemptResult({
        terminal: { kind: "timeout", phase: "prompt", source: "runtime" },
        assistantTexts: [],
        lastAssistant: staleAssistant,
        currentAttemptAssistant: undefined,
        currentAttemptCompletedAssistant: undefined,
      }),
      currentAttemptCompletedAssistant: undefined,
      terminalState: hardTimeoutState(),
    });

    expect(prepared.finalAssistantVisibleText).toBe("");
    expect(prepared.recoveredFinalAssistantPayloadsAfterPromptTimeout).toBeUndefined();
    expect(prepared.hasSuccessfulFinalAssistantAfterPromptTimeout).toBe(false);
  });

  it("excludes cleanup and earlier completed assistants from clean-yield payloads", async () => {
    const completedAssistant = assistantMessage("stop");
    const yieldedAssistant = {
      ...assistantMessage("aborted"),
      content: [
        { type: "toolCall" as const, id: "yield-1", name: "sessions_yield", arguments: {} },
      ],
    };
    const attempt = attemptResult({
      assistantTexts: [],
      lastAssistant: yieldedAssistant,
      currentAttemptAssistant: undefined,
      currentAttemptCompletedAssistant: completedAssistant,
      yieldDetected: true,
    });

    await prepareAttempt({
      attempt,
      currentAttemptCompletedAssistant: completedAssistant,
    });

    expect(payloadMocks.buildEmbeddedRunPayloads).toHaveBeenCalledWith(
      expect.objectContaining({ lastAssistant: undefined, currentAssistant: null }),
    );
  });
});
