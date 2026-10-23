import { describe, expect, it, vi } from "vitest";
import { makeTextToolResult } from "../../../../test/helpers/text-tool-result.js";
import { getReplyPayloadMetadata } from "../../../auto-reply/reply-payload.js";
import { SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import {
  buildEmbeddedRunnerAssistant as makeAssistant,
  makeEmbeddedRunnerAttempt as makeAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import type { EmbeddedRunAttemptWithReceiptEvidence } from "./attempt-result.js";
import { countSettledTurnDeliveryPayloads } from "./incomplete-turn-classification.js";
import { useFinalizationAdmission } from "./settled-finalization-harness.test-support.js";
import { prepareTerminalWithSettledTurnFinalization as finalize } from "./settled-turn-finalization.js";
import { createSettledFinalizationTestInput as makeInput } from "./settled-turn-finalization.test-support.js";
import { finalizationReply, toolAssistant } from "./settled-turn-fixtures.test-support.js";

const backendMocks = vi.hoisted(() => ({ finalize: vi.fn() }));
const transcriptMocks = vi.hoisted(() => ({ append: vi.fn() }));

vi.mock("./backend.js", () => ({
  resolveRuntimeModelAttempt: vi.fn(),
}));
// mock-isolation: finalization fixtures must not load or invoke the live agent harness.
vi.mock("../../harness/selection.js", () => ({
  runAgentHarnessSettledTurnFinalization: backendMocks.finalize,
}));
// mock-isolation: record synthetic mirror writes without loading transcript persistence.
vi.mock("../../../plugin-sdk/session-transcript-runtime.js", () => ({
  appendAssistantMirrorMessageByIdentity: transcriptMocks.append,
}));

describe("prepareTerminalWithSettledTurnFinalization canonical silence", () => {
  const getContext = useFinalizationAdmission([backendMocks.finalize, transcriptMocks.append]);

  it.each([
    ["required", "missing", "phased"],
    ["required", "pending-during-recovery", "plain"],
    ["required", "unknown-during-recovery", "plain"],
    ["required", "missing", "mirror"],
    ["required", "missing", "preceding"],
    ["required", "unknown", "plain"],
    ["optional", "missing", "plain"],
    ["result-required", "missing", "plain"],
    ["result-required", "pending-during-recovery", "plain"],
    ["result-required", "unknown-during-recovery", "plain"],
    ["result-required", "visible-during-recovery", "plain"],
    ["required", "missing", "empty"],
    ["result-required", "missing", "empty"],
  ] as const)(
    "settles %s/%s/%s followed by NO_REPLY without replaying tools",
    async (expectation, delivery, variant) => {
      const history = variant === "mirror" || variant === "preceding" ? variant : undefined;
      const emptyFinal = variant === "empty";
      const earlierText = "## Result\n\n- **Saved** the note.";
      const attempt: EmbeddedRunAttemptWithReceiptEvidence = makeAttempt({
        sessionIdUsed: "session-settled",
        sourceReplyDeliveryState: "missing",
        replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
        currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
      });
      const sendAssistant = toolAssistant(["send", "message"]);
      sendAssistant.content = [
        {
          type: "toolCall",
          id: "send",
          name: "message",
          arguments: { action: "send", target: "other-chat", message: "The requested update." },
        },
      ];
      const signedText = (text: string, id: string, phase: string) => ({
        type: "text" as const,
        text,
        textSignature: JSON.stringify({ v: 1, id, phase }),
      });
      const earlierAnswer = makeAssistant({
        stopReason: "toolUse",
        content: [signedText(earlierText, "earlier-answer", "final_answer")],
      });
      const assistant = makeAssistant({
        content:
          variant === "phased"
            ? [
                signedText("Nothing else to add.", "progress", "commentary"),
                signedText(SILENT_REPLY_TOKEN, "silent-answer", "final_answer"),
              ]
            : emptyFinal
              ? []
              : [{ type: "text", text: SILENT_REPLY_TOKEN }],
      });
      attempt.messagesSnapshot = [
        { role: "user", content: "Save the note and confirm when it is saved.", timestamp: 0 },
        sendAssistant,
        makeTextToolResult("send", "message", "Message sent to other-chat", false, 1),
        ...(emptyFinal ? [] : [earlierAnswer]),
        assistant,
      ];
      attempt.toolMetas = [{ toolName: "message", meta: "send", replaySafe: false }];
      attempt.itemLifecycle = { startedCount: 1, completedCount: 1, activeCount: 0 };
      attempt.assistantTexts = emptyFinal ? [] : [earlierText, SILENT_REPLY_TOKEN];
      attempt.lastAssistant = assistant;
      attempt.currentAttemptAssistant = assistant;
      attempt.currentAttemptCompletedAssistant = assistant;
      if (history === "mirror") {
        attempt.messagingToolSourceReplyPayloads = [
          { text: "Earlier committed reply.", sourceReplyFinal: true },
        ];
      } else if (history === "preceding") {
        attempt.answerSegments = [
          {
            textEnd: 1,
            messageEnd: 3,
            finalMessageStart: 1,
            lastAssistant: earlierAnswer,
            sourceReplyDeliveryState: "missing",
          },
        ];
      }
      attempt.settledTurnFinalizationContext = {
        source: "openclaw-transcript",
        messages: Object.freeze([...attempt.messagesSnapshot]),
      };
      const input = makeInput(attempt, getContext());
      const runAttempt = vi.spyOn(input.finalization.harness, "runAttempt");
      input.terminalBase.runParams.trigger = "user";
      input.terminalBase.runParams.terminalReplyExpectation = expectation;
      input.terminalBase.runParams.allowEmptyAssistantReplyAsSilent = true;
      let observations = 0;
      input.terminalBase.runParams.resolveReplyDelivery = async () => {
        observations += 1;
        if (delivery === "visible-during-recovery") {
          return observations === 1 ? "missing" : "delivered";
        }
        if (delivery === "pending-during-recovery" || delivery === "unknown-during-recovery") {
          if (observations === 1) {
            return "missing";
          }
          if (delivery === "unknown-during-recovery") {
            throw new Error("Source receipt unavailable during recovery");
          }
          return "pending";
        }
        if (delivery === "unknown") {
          throw new Error("Source receipt unavailable");
        }
        return delivery;
      };
      if (delivery === "visible-during-recovery") {
        const resolveTerminalDelivery = input.terminalBase.runParams.resolveReplyDelivery;
        input.terminalBase.runParams.resolveReplyDeliveryFacts = async (minimum) => ({
          source: "missing",
          terminal: await resolveTerminalDelivery(minimum),
        });
        input.terminalBase.runParams.resolveReplyDelivery = undefined;
      }
      const finalText =
        emptyFinal && expectation !== "result-required" ? SILENT_REPLY_TOKEN : "The note is saved.";
      backendMocks.finalize.mockResolvedValueOnce(
        finalizationReply(finalText === SILENT_REPLY_TOKEN ? "empty" : "answered", finalText),
      );

      const result = await finalize(input);

      const shouldFinalize = !history && (expectation === "result-required" || emptyFinal);
      expect(backendMocks.finalize).toHaveBeenCalledTimes(shouldFinalize ? 1 : 0);
      expect(result.finalizationOutcome).toBe(shouldFinalize ? "answered" : "not-attempted");
      expect(runAttempt).not.toHaveBeenCalled();
      if (history) {
        expect(result.prepared.replyDeliveryState).toBe("missing");
        expect(result.prepared.payloadsWithToolMedia).toEqual([
          expect.objectContaining({
            text: history === "mirror" ? "Earlier committed reply." : earlierText,
          }),
        ]);
        expect(getReplyPayloadMetadata(result.prepared.payloadsWithToolMedia![0]!)).toHaveProperty(
          history === "mirror" ? "sourceReplyTranscriptMirror" : "precedingInputAnswer",
        );
        expect(
          countSettledTurnDeliveryPayloads({
            payloads: result.prepared.payloadsWithToolMedia,
            attempt,
          }),
        ).toBe(1);
        expect(observations).toBe(1);
        return;
      }
      const pendingDuringRecovery =
        delivery === "pending-during-recovery" || delivery === "unknown-during-recovery";
      if (expectation === "result-required") {
        const [preparedAttempt] = backendMocks.finalize.mock.calls[0] ?? [];
        expect(preparedAttempt).toMatchObject({
          operation: "settled-tool-finalization",
          disableTools: true,
          skipPreparedUserTurnMessage: true,
          suppressNextUserMessagePersistence: true,
        });
        expect(preparedAttempt.prompt).toContain("produce the required result now");
        expect(preparedAttempt.prompt).toContain("NO_REPLY is not allowed");
        expect(result.prepared.payloadsWithToolMedia).toEqual(
          pendingDuringRecovery ? [] : [expect.objectContaining({ text: finalText })],
        );
        expect(result.prepared.replyDeliveryState).toBe(
          delivery === "visible-during-recovery"
            ? "delivered"
            : pendingDuringRecovery
              ? "pending"
              : "missing",
        );
        if (delivery === "visible-during-recovery") {
          expect(observations).toBe(2);
          expect(result.prepared.sourceReplyDeliveryState).toBe("missing");
        }
      } else if (emptyFinal) {
        const [preparedAttempt] = backendMocks.finalize.mock.calls[0] ?? [];
        expect(preparedAttempt.prompt).toContain(
          "If your completed actions already answered the request, answer exactly NO_REPLY.",
        );
        expect(result.prepared.preparedTerminalReply.terminalReply).toEqual({
          disposition: "silent",
        });
        expect(result.prepared.payloadsWithToolMedia).toEqual([]);
      } else {
        expect(result.prepared.payloadsWithToolMedia).toEqual([]);
        if (delivery === "unknown") {
          expect(result.prepared.replyDeliveryState).toBe("pending");
        }
      }
      expect(transcriptMocks.append).not.toHaveBeenCalled();
    },
  );
});
