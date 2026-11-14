import { describe, expect, it, vi } from "vitest";
import { resolveSourceReplyExpectation } from "../../../auto-reply/reply/source-reply-delivery-mode.js";
import { SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import {
  buildEmbeddedRunnerAssistant as makeAssistant,
  makeEmbeddedRunnerAttempt as makeAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import type { EmbeddedRunAttemptWithReceiptEvidence } from "./attempt-result.js";
import { useFinalizationAdmission } from "./settled-finalization-harness.test-support.js";
import { prepareTerminalWithSettledTurnFinalization as finalize } from "./settled-turn-finalization.js";
import { createSettledFinalizationTestInput as makeInput } from "./settled-turn-finalization.test-support.js";
import { finalizationReply, settledBatch } from "./settled-turn-fixtures.test-support.js";

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

  it("makes an internal scheduled heartbeat optional rather than result-required", () => {
    const source = { cfg: {}, ctx: { Provider: "webchat", SessionKey: "agent:main:main" } };
    expect(resolveSourceReplyExpectation(source)).toBe("result-required");
    expect(resolveSourceReplyExpectation({ ...source, scheduledAutomation: true })).toBe(
      "optional",
    );
  });

  it.each([
    ["required", "missing", "phased"],
    ["required", "missing", "plain"],
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
      const emptyFinal = variant === "empty";
      const earlierText = "## Result\n\n- **Saved** the note.";
      const batch = settledBatch(["send", "message"]);
      const attempt: EmbeddedRunAttemptWithReceiptEvidence = makeAttempt({
        ...batch,
        sessionIdUsed: "session-settled",
        sourceReplyDeliveryState: "missing",
        replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
        currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
      });
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
        ...batch.messagesSnapshot,
        ...(emptyFinal ? [] : [earlierAnswer]),
        assistant,
      ];
      attempt.toolMetas = [{ toolName: "message", meta: "send", replaySafe: false }];
      attempt.assistantTexts = emptyFinal ? [] : [earlierText, SILENT_REPLY_TOKEN];
      attempt.lastAssistant = assistant;
      attempt.currentAttemptAssistant = assistant;
      attempt.currentAttemptCompletedAssistant = assistant;
      attempt.settledTurnFinalizationContext = {
        source: "openclaw-transcript",
        messages: Object.freeze([...attempt.messagesSnapshot]),
      };
      const input = makeInput(attempt, getContext());
      const runAttempt = vi.spyOn(input.finalization.harness, "runAttempt");
      const params = input.terminalBase.runParams;
      params.trigger = "user";
      params.terminalReplyExpectation = expectation;
      params.allowEmptyAssistantReplyAsSilent = true;
      let observations = 0;
      params.resolveReplyDelivery = async () => {
        observations += 1;
        if (delivery.endsWith("-during-recovery") && observations === 1) {
          return "missing";
        }
        if (delivery.startsWith("unknown")) {
          throw new Error("Source receipt unavailable");
        }
        return delivery === "visible-during-recovery"
          ? "delivered"
          : delivery === "pending-during-recovery"
            ? "pending"
            : "missing";
      };
      if (delivery === "visible-during-recovery") {
        const resolveTerminalDelivery = params.resolveReplyDelivery;
        params.resolveReplyDeliveryFacts = async (minimum) => ({
          source: "missing",
          terminal: await resolveTerminalDelivery(minimum),
        });
        params.resolveReplyDelivery = undefined;
      }
      const finalText =
        emptyFinal && expectation !== "result-required" ? SILENT_REPLY_TOKEN : "The note is saved.";
      backendMocks.finalize.mockResolvedValueOnce(
        finalizationReply(finalText === SILENT_REPLY_TOKEN ? "empty" : "answered", finalText),
      );

      const { finalizationOutcome, prepared } = await finalize(input);

      const shouldFinalize = expectation === "result-required" || emptyFinal;
      expect(backendMocks.finalize).toHaveBeenCalledTimes(shouldFinalize ? 1 : 0);
      expect(finalizationOutcome).toBe(shouldFinalize ? "answered" : "not-attempted");
      expect(runAttempt).not.toHaveBeenCalled();
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
        expect(prepared.payloadsWithToolMedia).toEqual(
          pendingDuringRecovery ? [] : [expect.objectContaining({ text: finalText })],
        );
        expect(prepared.replyDeliveryState).toBe(
          delivery === "visible-during-recovery"
            ? "delivered"
            : pendingDuringRecovery
              ? "pending"
              : "missing",
        );
        if (delivery === "visible-during-recovery") {
          expect(observations).toBe(2);
          expect(prepared.sourceReplyDeliveryState).toBe("missing");
        }
      } else if (emptyFinal) {
        expect(prepared.preparedTerminalReply.terminalReply).toEqual({
          disposition: "silent",
        });
        expect(prepared.payloadsWithToolMedia).toEqual([]);
      } else {
        expect(prepared.payloadsWithToolMedia).toEqual([]);
        if (expectation === "optional") {
          expect(prepared.preparedTerminalReply.terminalReply).toEqual({ disposition: "silent" });
        }
        if (delivery === "unknown") {
          expect(prepared.replyDeliveryState).toBe("pending");
        }
      }
      expect(transcriptMocks.append).not.toHaveBeenCalled();
    },
  );
});
