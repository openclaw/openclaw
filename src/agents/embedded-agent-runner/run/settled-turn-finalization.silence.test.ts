import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTextToolResult } from "../../../../test/helpers/text-tool-result.js";
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
}));
vi.mock("../../harness/selection.js", () => ({
  runAgentHarnessSettledTurnFinalization: backendMocks.runSettledFinalization,
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
    {
      name: "required phased confirmation",
      expectation: "required",
      delivery: "missing",
      phased: true,
      terminalText: SILENT_REPLY_TOKEN,
    },
    {
      name: "confirmation committed during recovery",
      expectation: "required",
      delivery: "delivered-during-recovery",
      phased: false,
      terminalText: "",
    },
    {
      name: "confirmation held during recovery",
      expectation: "required",
      delivery: "pending-during-recovery",
      phased: false,
      terminalText: "",
    },
    {
      name: "delivered confirmation",
      expectation: "required",
      delivery: "delivered",
      phased: false,
      terminalText: SILENT_REPLY_TOKEN,
    },
    {
      name: "pending confirmation",
      expectation: "required",
      delivery: "pending",
      phased: false,
      terminalText: SILENT_REPLY_TOKEN,
    },
    {
      name: "unconfirmed receipt",
      expectation: "required",
      delivery: "unknown",
      phased: false,
      terminalText: SILENT_REPLY_TOKEN,
    },
    {
      name: "optional helper",
      expectation: "optional",
      delivery: "missing",
      phased: false,
      terminalText: SILENT_REPLY_TOKEN,
    },
  ] as const)(
    "settles $name with terminal text '$terminalText' without replaying tools",
    async ({ expectation, delivery, phased, terminalText }) => {
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
            text: earlierText,
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
                text: terminalText,
                textSignature: JSON.stringify({ v: 1, id: "silent-answer", phase: "final_answer" }),
              },
            ]
          : [{ type: "text", text: terminalText }],
      });
      attempt.messagesSnapshot = [
        { role: "user", content: "Save the note and confirm when it is saved.", timestamp: 0 },
        toolAssistant,
        makeTextToolResult("reaction", "message", "Reaction added", false, 1),
        ...(terminalText ? [earlierAnswer] : []),
        assistant,
      ];
      attempt.toolMetas = [{ toolName: "message", meta: "react", replaySafe: false }];
      attempt.itemLifecycle = { startedCount: 1, completedCount: 1, activeCount: 0 };
      attempt.assistantTexts = terminalText ? [earlierText, terminalText] : [];
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
      if (deliveredDuringRecovery) {
        expect(backendMocks.runSettledFinalization).toHaveBeenCalledOnce();
        const [preparedAttempt] = backendMocks.runSettledFinalization.mock.calls[0] ?? [];
        expect(preparedAttempt).toMatchObject({
          operation: "settled-tool-finalization",
          disableTools: true,
          skipPreparedUserTurnMessage: true,
          suppressNextUserMessagePersistence: true,
        });
        expect(result.finalizationOutcome).toBe("answered");
        expect(result.prepared.payloadsWithToolMedia).toEqual([]);
        expect(result.prepared.replyDeliveryState).toBe(
          delivery === "delivered-during-recovery" ? "delivered" : "pending",
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
