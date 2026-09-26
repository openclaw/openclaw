import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import {
  prepareSystemAgentRunAdmission,
  type AdmittedRunContext,
} from "../../admitted-run-context.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { prepareTerminalWithSettledTurnFinalization } from "./settled-turn-finalization.js";
import { createSettledFinalizationTestInput } from "./settled-turn-finalization.test-support.js";

const backendMocks = vi.hoisted(() => ({ runSettledFinalization: vi.fn() }));
const transcriptMocks = vi.hoisted(() => ({ appendAssistantMirrorMessageByIdentity: vi.fn() }));

vi.mock("./backend.js", () => ({
  resolveRuntimeModelAttempt: vi.fn(),
  runEmbeddedSettledTurnFinalizationWithBackend: backendMocks.runSettledFinalization,
}));
vi.mock("../../../plugin-sdk/session-transcript-runtime.js", () => ({
  appendAssistantMirrorMessageByIdentity: transcriptMocks.appendAssistantMirrorMessageByIdentity,
}));

describe("prepareTerminalWithSettledTurnFinalization canonical silence", () => {
  let admission: ReturnType<typeof prepareSystemAgentRunAdmission>;
  let admittedRunContext: AdmittedRunContext;
  beforeEach(async () => {
    backendMocks.runSettledFinalization.mockReset();
    transcriptMocks.appendAssistantMirrorMessageByIdentity.mockReset();
    admission = prepareSystemAgentRunAdmission({}, "run-settled", "main", "finalization-test");
    admittedRunContext = await admission.admit("embedded");
  });
  afterEach(() => admission.close());

  it.each([
    { name: "required confirmation", expectation: "required", delivery: "missing", phased: false },
    {
      name: "required phased confirmation",
      expectation: "required",
      delivery: "missing",
      phased: true,
    },
    {
      name: "confirmation committed during recovery",
      expectation: "required",
      delivery: "delivered-during-recovery",
      phased: false,
    },
    {
      name: "confirmation held during recovery",
      expectation: "required",
      delivery: "pending-during-recovery",
      phased: false,
    },
    {
      name: "delivered confirmation",
      expectation: "required",
      delivery: "delivered",
      phased: false,
    },
    { name: "pending confirmation", expectation: "required", delivery: "pending", phased: false },
    { name: "unconfirmed receipt", expectation: "required", delivery: "unknown", phased: false },
    { name: "optional helper", expectation: "optional", delivery: "missing", phased: false },
  ] as const)(
    "settles $name followed by NO_REPLY without replaying tools",
    async ({ expectation, delivery, phased }) => {
      const earlierText = "## Result\n\n- **Saved** the note.";
      const attempt = makeEmbeddedRunnerAttempt({
        sessionIdUsed: "session-settled",
        replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
        currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
      });
      const toolAssistant = buildEmbeddedRunnerAssistant({
        stopReason: "toolUse",
        content: [
          { type: "toolCall", id: "reaction", name: "message", arguments: { action: "react" } },
        ],
      });
      const earlierAnswer = buildEmbeddedRunnerAssistant({
        stopReason: "toolUse",
        content: [
          {
            type: "text",
            text: earlierText ?? "",
            textSignature: JSON.stringify({ v: 1, id: "earlier-answer", phase: "final_answer" }),
          },
        ],
      });
      const assistant = buildEmbeddedRunnerAssistant({
        content: phased
          ? [
              {
                type: "text",
                text: "Nothing else to add.",
                textSignature: JSON.stringify({ v: 1, id: "progress", phase: "commentary" }),
              },
              {
                type: "text",
                text: SILENT_REPLY_TOKEN,
                textSignature: JSON.stringify({ v: 1, id: "silent-answer", phase: "final_answer" }),
              },
            ]
          : [{ type: "text", text: SILENT_REPLY_TOKEN }],
      });
      attempt.messagesSnapshot = [
        { role: "user", content: "Save the note and confirm when it is saved.", timestamp: 0 },
        toolAssistant,
        {
          role: "toolResult",
          toolCallId: "reaction",
          toolName: "message",
          content: [{ type: "text", text: "Reaction added" }],
          isError: false,
          timestamp: 1,
        },
        earlierAnswer,
        assistant,
      ];
      attempt.toolMetas = [{ toolName: "message", meta: "react", replaySafe: false }];
      attempt.itemLifecycle = { startedCount: 1, completedCount: 1, activeCount: 0 };
      attempt.assistantTexts = [earlierText, SILENT_REPLY_TOKEN];
      attempt.lastAssistant = assistant;
      attempt.currentAttemptAssistant = assistant;
      attempt.currentAttemptCompletedAssistant = assistant;
      attempt.settledTurnFinalizationContext = {
        source: "openclaw-transcript",
        messages: Object.freeze([...attempt.messagesSnapshot]),
      };
      const input = createSettledFinalizationTestInput(attempt, admittedRunContext);
      const runAttempt = vi.spyOn(input.finalization.harness, "runAttempt");
      input.terminalBase.runParams.trigger = "user";
      input.terminalBase.runParams.terminalReplyExpectation = expectation;
      input.terminalBase.runParams.allowEmptyAssistantReplyAsSilent = true;
      let observations = 0;
      input.terminalBase.runParams.resolveReplyDelivery = async () => {
        observations += 1;
        if (delivery === "delivered-during-recovery" || delivery === "pending-during-recovery") {
          return observations === 1
            ? "missing"
            : delivery === "delivered-during-recovery"
              ? "delivered"
              : "pending";
        }
        if (delivery === "unknown") {
          throw new Error("Source receipt unavailable");
        }
        return delivery;
      };
      const finalText = "The note is saved.";
      backendMocks.runSettledFinalization.mockResolvedValueOnce({
        outcome: "answered",
        result: {
          assistant: buildEmbeddedRunnerAssistant({
            content: [{ type: "text", text: finalText }],
          }),
        },
      });

      const result = await prepareTerminalWithSettledTurnFinalization(input);

      const deliveredDuringRecovery =
        delivery === "delivered-during-recovery" || delivery === "pending-during-recovery";
      if (expectation === "required" && (delivery === "missing" || deliveredDuringRecovery)) {
        expect(backendMocks.runSettledFinalization).toHaveBeenCalledOnce();
        const [preparedAttempt] = backendMocks.runSettledFinalization.mock.calls[0] ?? [];
        expect(preparedAttempt).toMatchObject({
          operation: "settled-tool-finalization",
          disableTools: true,
          skipPreparedUserTurnMessage: true,
          suppressNextUserMessagePersistence: true,
        });
        expect(result.finalizationOutcome).toBe("answered");
        expect(result.prepared.payloadsWithToolMedia).toEqual(
          deliveredDuringRecovery ? [] : [expect.objectContaining({ text: finalText })],
        );
        expect(result.prepared.replyDeliveryState).toBe(
          deliveredDuringRecovery
            ? delivery === "delivered-during-recovery"
              ? "delivered"
              : "pending"
            : "missing",
        );
      } else {
        expect(backendMocks.runSettledFinalization).not.toHaveBeenCalled();
        expect(result.finalizationOutcome).toBe("not-attempted");
        expect(result.prepared.payloadsWithToolMedia).toEqual([]);
        if (delivery === "unknown") {
          expect(result.prepared.replyDeliveryState).toBe("pending");
        }
      }
      expect(runAttempt).not.toHaveBeenCalled();
      expect(transcriptMocks.appendAssistantMirrorMessageByIdentity).not.toHaveBeenCalled();
    },
  );
});
