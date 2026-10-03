import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTextToolResult } from "../../../../test/helpers/text-tool-result.js";
import { settleReplyDispatcher } from "../../../auto-reply/dispatch-dispatcher.js";
import {
  describe2BeforeEach0,
  dispatchReplyFromConfig,
  globalBeforeAll0,
  setNoAbort,
} from "../../../auto-reply/reply/dispatch-from-config.test-harness.js";
import { createReplyDispatcher } from "../../../auto-reply/reply/reply-dispatcher.js";
import { buildTestCtx } from "../../../auto-reply/reply/test-ctx.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import {
  buildEmbeddedRunnerAssistant,
  createResolvedEmbeddedRunnerModel,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { prepareTerminalWithSettledTurnFinalization } from "./settled-turn-finalization.js";
import { createSettledFinalizationTestInput } from "./settled-turn-finalization.test-support.js";

beforeAll(globalBeforeAll0);

describe("settled finalizer through source dispatch", () => {
  let admission: ReturnType<typeof prepareSystemAgentRunAdmission>;
  beforeEach(() => {
    describe2BeforeEach0();
    setNoAbort();
    admission = prepareSystemAgentRunAdmission({}, "run-settled", "main", "source-finalizer");
  });
  afterEach(() => admission.close());

  it.each([
    { mode: "message_tool_only", receipt: "progress", finalization: "answered" },
    { mode: "automatic", receipt: "progress", finalization: "answered" },
    { mode: "message_tool_only", receipt: "progress", finalization: "empty" },
    { mode: "message_tool_only", receipt: "progress", finalization: "failed" },
    { mode: "message_tool_only", receipt: "progress", finalization: "cancelled" },
    { mode: "message_tool_only", receipt: "off-target", finalization: "not-attempted" },
    { mode: "message_tool_only", receipt: "completed", finalization: "not-attempted" },
    { mode: "message_tool_only", receipt: "progress", finalization: "not-attempted" },
  ] as const)(
    "$mode: $receipt with finalization=$finalization delivers only the intended answer",
    async ({ mode, receipt, finalization }) => {
      const recovered = finalization !== "not-attempted";
      const answered = finalization === "answered";
      const controller = new AbortController();
      const finalText = "The note was saved.";
      const progressText = "Saving the note.";
      const assistant = buildEmbeddedRunnerAssistant({
        provider: "openai",
        model: "gpt-4.1",
        stopReason: recovered || receipt === "completed" ? "toolUse" : "stop",
        content:
          recovered || receipt === "completed"
            ? [{ type: "toolCall", id: "write-note", name: "write", arguments: {} }]
            : [{ type: "text", text: "Private completion details." }],
      });
      const toolResult = makeTextToolResult("write-note", "write", "Saved", false, 1);
      const attempt = makeEmbeddedRunnerAttempt({
        sessionIdUsed: "session-settled",
        terminal: { kind: "ok" },
        assistantTexts: recovered || receipt === "completed" ? [] : ["Private completion details."],
        lastAssistant: assistant,
        currentAttemptAssistant: assistant,
        currentAttemptCompletedAssistant: assistant,
        messagesSnapshot: [
          { role: "user", content: "Save the note, then summarize.", timestamp: 0 },
          assistant,
          toolResult,
        ],
        toolMetas: [
          { toolName: "write", toolCallId: "write-note", isError: false, replaySafe: false },
        ],
        itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
        replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
        currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
        didSendViaMessagingTool: true,
        didDeliverSourceReplyViaMessageTool: receipt !== "off-target",
        messagingToolSentTexts: [receipt === "completed" ? finalText : progressText],
        messagingToolSentTargets: [
          {
            tool: "message",
            provider: "telegram",
            to: receipt === "off-target" ? "synthetic-other" : "synthetic-source",
            text: receipt === "completed" ? finalText : progressText,
            ...(receipt !== "off-target" ? { sourceReplyFinal: receipt === "completed" } : {}),
          },
        ],
      });
      const input = createSettledFinalizationTestInput(attempt, await admission.admit("embedded"));
      const runAttempt = vi.spyOn(input.finalization.harness, "runAttempt");
      Object.assign(
        input.finalization.preparedAttempt,
        createResolvedEmbeddedRunnerModel("openai", "gpt-4.1"),
      );
      input.finalization.abortSignal = controller.signal;
      input.terminalBase.runParams.trigger = "user";
      input.terminalBase.runParams.sourceReplyDeliveryMode = mode;
      input.terminalBase.model = "gpt-4.1";
      input.terminalBase.activeErrorContext.model = "gpt-4.1";
      const finalize = vi.fn<NonNullable<typeof input.finalization.harness.finalizeSettledTurn>>(
        async ({ attempt: prepared, settledAttempt }) => {
          expect(prepared).toMatchObject({
            disableTools: true,
            operation: "settled-tool-finalization",
          });
          expect(settledAttempt).toBe(attempt);
          if (finalization === "failed") {
            throw new Error("Synthetic finalizer failure");
          }
          if (finalization === "cancelled") {
            controller.abort(new Error("Synthetic cancellation"));
          }
          return {
            assistant: buildEmbeddedRunnerAssistant({
              provider: "openai",
              model: "gpt-4.1",
              content: finalization === "empty" ? [] : [{ type: "text", text: finalText }],
            }),
          };
        },
      );
      input.finalization.harness.finalizeSettledTurn = finalize;
      const deliver = vi.fn(async () => undefined);
      const dispatcher = createReplyDispatcher({ deliver });
      let finalized:
        | Awaited<ReturnType<typeof prepareTerminalWithSettledTurnFinalization>>
        | undefined;

      await dispatchReplyFromConfig({
        ctx: buildTestCtx({
          Provider: "telegram",
          Surface: "telegram",
          ChatType: "direct",
          SessionKey: "agent:main:telegram:direct:synthetic",
          MessageSid: "synthetic-request",
        }),
        cfg: {},
        dispatcher,
        replyOptions: { sourceReplyDeliveryMode: mode },
        replyResolver: async () => {
          finalized = await prepareTerminalWithSettledTurnFinalization(input);
          return finalized.prepared.payloadsWithToolMedia;
        },
      });
      await settleReplyDispatcher({ dispatcher });

      expect(finalized?.finalizationOutcome).toBe(
        finalization === "empty"
          ? "completed-empty"
          : finalization === "cancelled"
            ? "failed"
            : finalization,
      );
      expect(finalize).toHaveBeenCalledTimes(finalization === "empty" ? 2 : recovered ? 1 : 0);
      expect(runAttempt).not.toHaveBeenCalled();
      expect(finalized?.attempt.messagingToolSentTargets).toEqual(attempt.messagingToolSentTargets);
      expect(deliver).toHaveBeenCalledTimes(answered ? 1 : 0);
      if (answered) {
        expect(deliver).toHaveBeenCalledWith(
          expect.objectContaining({ text: finalText }),
          expect.anything(),
        );
      }
      expect(dispatcher.getFailedCounts()).toEqual({ tool: 0, block: 0, final: 0 });
    },
  );
});
