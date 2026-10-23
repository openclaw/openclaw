import { describe, expect, it, vi } from "vitest";
import { makeTextToolResult } from "../../../../test/helpers/text-tool-result.js";
import { getReplyPayloadMetadata } from "../../../auto-reply/reply-payload.js";
import { makeEmbeddedRunnerAttempt } from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { TOOL_FAILURE_INSTRUCTION } from "../../tool-outcome-instructions.js";
import type { EmbeddedRunAttemptWithReceiptEvidence } from "./attempt-result.js";
import { useFinalizationAdmission } from "./settled-finalization-harness.test-support.js";
import { prepareTerminalWithSettledTurnFinalization } from "./settled-turn-finalization.js";
import { createSettledFinalizationTestInput } from "./settled-turn-finalization.test-support.js";
import { finalizationReply, toolAssistant } from "./settled-turn-fixtures.test-support.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

const mocks = vi.hoisted(() => ({ finalize: vi.fn(), append: vi.fn() }));
const denial = Object.freeze({
  toolName: "exec",
  error: "SYSTEM_RUN_DENIED: approval required",
  errorCode: "SYSTEM_RUN_DENIED",
});

vi.mock("./backend.js", () => ({
  resolveRuntimeModelAttempt: vi.fn(),
}));
// mock-isolation: finalization fixtures must not load or invoke the live agent harness.
vi.mock("../../harness/selection.js", () => ({
  runAgentHarnessSettledTurnFinalization: mocks.finalize,
}));
// mock-isolation: record synthetic mirror writes without loading transcript persistence.
vi.mock("../../../plugin-sdk/session-transcript-runtime.js", () => ({
  appendAssistantMirrorMessageByIdentity: mocks.append,
}));
// This suite stubs persistence; resolve its synthetic paths without opening a
// host database. The runner boundary suite uses the real resolver and SQLite.
// mock-isolation: synthetic session targets must not open the host session database.
vi.mock("../../run-session-target.js", () => ({
  resolveAgentRunSessionTarget: vi.fn(
    async (
      params: Pick<
        EmbeddedRunAttemptParams,
        "agentId" | "sessionId" | "sessionKey" | "sessionTarget"
      >,
    ) => ({
      agentId: params.sessionTarget?.agentId ?? params.agentId ?? "main",
      sessionId: params.sessionTarget?.sessionId ?? params.sessionId,
      sessionKey: params.sessionTarget?.sessionKey ?? params.sessionKey ?? "agent:main:settled",
      storePath: params.sessionTarget?.storePath ?? "/synthetic/sessions.json",
    }),
  ),
}));

function settledSuccessfulAttemptAfterStaleError(
  retainProgress: boolean,
): EmbeddedRunAttemptWithReceiptEvidence {
  const progress = "I’ll inspect the file before answering.";
  const failedAssistant = toolAssistant(["tool-failed", "exec"]);
  const terminalAssistant = toolAssistant(["tool-succeeded", "read"]);
  terminalAssistant.content.unshift({
    type: "text",
    text: progress,
    ...(!retainProgress
      ? { textSignature: JSON.stringify({ v: 1, id: "progress", phase: "commentary" }) }
      : {}),
  });
  return makeEmbeddedRunnerAttempt({
    sessionIdUsed: "session-settled",
    assistantTexts: retainProgress ? [progress] : [],
    lastAssistantTextMessageIndex: retainProgress ? 3 : undefined,
    messagesSnapshot: [
      { role: "user", content: "Inspect the file.", timestamp: 0 },
      failedAssistant,
      makeTextToolResult("tool-failed", "exec", denial.error, true, 1),
      terminalAssistant,
      makeTextToolResult("tool-succeeded", "read", "The requested value", false, 2),
    ],
    toolMetas: [
      { toolName: "exec", toolCallId: "tool-failed", isError: true, replaySafe: false },
      { toolName: "read", toolCallId: "tool-succeeded", isError: false, replaySafe: true },
    ],
    itemLifecycle: { startedCount: 2, completedCount: 2, activeCount: 0 },
    lastAssistant: terminalAssistant,
    currentAttemptCompletedAssistant: terminalAssistant,
    lastToolError: denial,
    replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
    currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
  });
}

const getContext = useFinalizationAdmission([mocks.finalize, mocks.append]);

function finalizationInput(attempt: EmbeddedRunAttemptWithReceiptEvidence) {
  const input = createSettledFinalizationTestInput(attempt, getContext());
  input.terminalBase.model = "gpt-4.1";
  input.terminalBase.activeErrorContext.model = "gpt-4.1";
  return input;
}

describe("settled-turn finalization after an earlier tool failure", () => {
  it.each([
    { outcome: "answered", retainProgress: true },
    { outcome: "failed", retainProgress: false },
  ] as const)(
    "preserves a cron exec denial after a successful read (finalizer: $outcome, visible progress: $retainProgress) (#132762)",
    async ({ outcome, retainProgress }) => {
      const attempt = settledSuccessfulAttemptAfterStaleError(retainProgress);
      const input = finalizationInput(attempt);
      input.terminalBase.runParams.sourceReplyDeliveryMode = "automatic";
      const finalText = "The command was denied. The file contains the requested value.";
      if (outcome === "failed") {
        mocks.finalize.mockRejectedValueOnce(new Error("finalizer unavailable"));
      } else {
        mocks.finalize.mockResolvedValue(finalizationReply(outcome, finalText));
      }

      const result = await prepareTerminalWithSettledTurnFinalization(input);

      expect(attempt.lastToolError).toBe(denial);
      expect(result.prepared).toMatchObject({
        attemptToolSummary: { unresolvedError: { toolName: "exec" } },
        failureSignal: {
          kind: "execution_denied",
          source: "tool",
          toolName: "exec",
          code: "SYSTEM_RUN_DENIED",
          message: denial.error,
          fatalForCron: true,
        },
      });
      expect(mocks.finalize).toHaveBeenCalledOnce();
      const [preparedAttempt, settledAttempt] = mocks.finalize.mock.calls[0]!;
      expect(preparedAttempt).toMatchObject({
        disableTools: true,
        skipPreparedUserTurnMessage: true,
        suppressNextUserMessagePersistence: true,
      });
      // #178300: the unrecovered earlier failure must reach the summary's instruction.
      expect(preparedAttempt.prompt).toContain(TOOL_FAILURE_INSTRUCTION);
      expect(settledAttempt).toBe(attempt);
      expect(result.finalizationOutcome).toBe(outcome);
      expect(mocks.append).not.toHaveBeenCalled();
      if (outcome === "answered") {
        expect(result.prepared.payloadsWithToolMedia).toEqual([
          expect.objectContaining({ text: finalText }),
        ]);
        expect(result.attempt.messagesSnapshot.slice(0, -1)).toEqual(attempt.messagesSnapshot);
      } else {
        expect(result.attempt).toBe(attempt);
        const warning = result.prepared.payloadsWithToolMedia?.find((payload) => payload.isError);
        expect(warning).toMatchObject({ text: expect.stringContaining("failed"), isError: true });
        expect(getReplyPayloadMetadata(warning ?? {})).toMatchObject({
          toolErrorWarning: { toolName: "exec" },
        });
      }
    },
  );
});
