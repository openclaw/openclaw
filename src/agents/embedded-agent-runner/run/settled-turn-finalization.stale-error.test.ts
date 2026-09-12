import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTextToolResult } from "../../../../test/helpers/text-tool-result.js";
import { getReplyPayloadMetadata } from "../../../auto-reply/reply-payload.js";
import {
  prepareSystemAgentRunAdmission,
  type AdmittedRunContext,
} from "../../admitted-run-context.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import type { EmbeddedRunAttemptWithReceiptEvidence } from "./attempt-result.js";
import { prepareTerminalWithSettledTurnFinalization } from "./settled-turn-finalization.js";
import { createSettledFinalizationTestInput } from "./settled-turn-finalization.test-support.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

const backendMocks = vi.hoisted(() => ({
  runSettledFinalization: vi.fn(),
}));
const transcriptMocks = vi.hoisted(() => ({
  appendAssistantMirrorMessageByIdentity: vi.fn(),
}));

vi.mock("./backend.js", () => ({
  resolveRuntimeModelAttempt: vi.fn(),
  runEmbeddedSettledTurnFinalizationWithBackend: backendMocks.runSettledFinalization,
}));
vi.mock("../../../plugin-sdk/session-transcript-runtime.js", () => ({
  appendAssistantMirrorMessageByIdentity: transcriptMocks.appendAssistantMirrorMessageByIdentity,
}));
// This suite stubs persistence; resolve its synthetic paths without opening a
// host database. The runner boundary suite uses the real resolver and SQLite.
vi.mock("../../run-session-target.js", () => ({
  resolveAgentRunSessionTarget: vi.fn(
    async (params: {
      agentId?: string;
      sessionId: string;
      sessionKey?: string;
      sessionTarget?: EmbeddedRunAttemptParams["sessionTarget"];
    }) => ({
      agentId: params.sessionTarget?.agentId ?? params.agentId ?? "main",
      sessionId: params.sessionTarget?.sessionId ?? params.sessionId,
      sessionKey: params.sessionTarget?.sessionKey ?? params.sessionKey ?? "agent:main:settled",
      storePath: params.sessionTarget?.storePath ?? "/synthetic/sessions.json",
    }),
  ),
}));

function settledSuccessfulAttemptAfterStaleError(
  retainProgress = true,
): EmbeddedRunAttemptWithReceiptEvidence {
  const progress = "I’ll inspect the file before answering.";
  const failedAssistant = buildEmbeddedRunnerAssistant({
    stopReason: "toolUse",
    content: [{ type: "toolCall", id: "tool-failed", name: "exec", arguments: {} }],
  });
  const terminalAssistant = buildEmbeddedRunnerAssistant({
    stopReason: "toolUse",
    content: [
      {
        type: "text",
        text: progress,
        ...(!retainProgress
          ? { textSignature: JSON.stringify({ v: 1, id: "progress", phase: "commentary" }) }
          : {}),
      },
      { type: "toolCall", id: "tool-succeeded", name: "read", arguments: {} },
    ],
  });
  return makeEmbeddedRunnerAttempt({
    terminal: { kind: "ok" },
    sessionIdUsed: "session-settled",
    assistantTexts: retainProgress ? [progress] : [],
    lastAssistantTextMessageIndex: retainProgress ? 3 : undefined,
    messagesSnapshot: [
      { role: "user", content: "Inspect the file.", timestamp: 0 },
      failedAssistant,
      makeTextToolResult("tool-failed", "exec", "Command exited with code 1", true, 1),
      terminalAssistant,
      makeTextToolResult("tool-succeeded", "read", "The requested value", false, 2),
    ],
    toolMetas: [
      { toolName: "exec", toolCallId: "tool-failed", isError: true, replaySafe: false },
      { toolName: "read", toolCallId: "tool-succeeded", isError: false, replaySafe: true },
    ],
    itemLifecycle: { startedCount: 2, completedCount: 2, activeCount: 0 },
    lastAssistant: terminalAssistant,
    currentAttemptAssistant: terminalAssistant,
    currentAttemptCompletedAssistant: terminalAssistant,
    lastToolError: { toolName: "exec", error: "Command exited with code 1" },
    replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
    currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
  });
}

let admittedRunContext: AdmittedRunContext;

function finalizationInput(attempt: EmbeddedRunAttemptWithReceiptEvidence) {
  const input = createSettledFinalizationTestInput(attempt, admittedRunContext);
  input.terminalBase.model = "gpt-4.1";
  input.terminalBase.activeErrorContext.model = "gpt-4.1";
  return input;
}

describe("settled-turn finalization after an earlier tool failure", () => {
  let admission: ReturnType<typeof prepareSystemAgentRunAdmission>;
  beforeEach(async () => {
    backendMocks.runSettledFinalization.mockReset();
    transcriptMocks.appendAssistantMirrorMessageByIdentity.mockReset();
    admission = prepareSystemAgentRunAdmission({}, "run-settled", "main", "finalization-test");
    admittedRunContext = await admission.admit("embedded");
  });
  afterEach(() => {
    admission.close();
  });

  it("preserves the original tool failure after progress when finalization fails (#132762)", async () => {
    const attempt = settledSuccessfulAttemptAfterStaleError();
    const input = finalizationInput(attempt);
    input.terminalBase.runParams.trigger = "user";
    input.terminalBase.runParams.sourceReplyDeliveryMode = "automatic";
    backendMocks.runSettledFinalization.mockRejectedValue(new Error("finalizer unavailable"));

    const result = await prepareTerminalWithSettledTurnFinalization(input);

    expect(backendMocks.runSettledFinalization).toHaveBeenCalledOnce();
    expect(result.attempt).toBe(attempt);
    expect(result.finalizationOutcome).toBe("failed");
    expect(result.attempt.lastToolError).toEqual({
      toolName: "exec",
      error: "Command exited with code 1",
    });
    expect(result.prepared.payloadsWithToolMedia).toEqual([
      expect.objectContaining({ text: "I’ll inspect the file before answering." }),
    ]);
    expect(getReplyPayloadMetadata(result.prepared.payloadsWithToolMedia?.[0] ?? {})).toMatchObject(
      { assistantMessageIndex: 3 },
    );
    expect(transcriptMocks.appendAssistantMirrorMessageByIdentity).not.toHaveBeenCalled();
  });

  it.each(
    (["answered", "failed", "empty", "unavailable", "cancelled"] as const).flatMap((outcome) => [
      { outcome, retainProgress: true },
      { outcome, retainProgress: false },
    ]),
  )(
    "preserves a cron exec denial after a successful read (finalizer: $outcome, visible progress: $retainProgress) (#132762)",
    async ({ outcome, retainProgress }) => {
      const attempt = settledSuccessfulAttemptAfterStaleError(retainProgress);
      const denial = {
        toolName: "exec",
        error: "SYSTEM_RUN_DENIED: approval required",
        errorCode: "SYSTEM_RUN_DENIED",
      };
      attempt.lastToolError = denial;
      attempt.messagesSnapshot[2] = makeTextToolResult(
        "tool-failed",
        "exec",
        denial.error,
        true,
        1,
      );
      const input = finalizationInput(attempt);
      input.terminalBase.runParams.sourceReplyDeliveryMode = "automatic";
      const controller = new AbortController();
      input.finalization.abortSignal = controller.signal;
      const finalText = "The command was denied. The file contains the requested value.";
      if (outcome === "unavailable") {
        input.finalization.harness.finalizeSettledTurn = undefined;
      } else if (outcome === "cancelled") {
        backendMocks.runSettledFinalization.mockImplementationOnce(async () => {
          const cancellation = new Error("cancelled by user");
          controller.abort(cancellation);
          throw cancellation;
        });
      } else if (outcome === "failed") {
        backendMocks.runSettledFinalization.mockRejectedValueOnce(
          new Error("finalizer unavailable"),
        );
      } else {
        backendMocks.runSettledFinalization.mockResolvedValue({
          outcome,
          result: {
            assistant: buildEmbeddedRunnerAssistant({
              content: outcome === "answered" ? [{ type: "text", text: finalText }] : [],
            }),
          },
        });
      }

      const result = await prepareTerminalWithSettledTurnFinalization(input);

      expect(attempt.lastToolError).toBe(denial);
      expect(result.prepared.failureSignal).toEqual({
        kind: "execution_denied",
        source: "tool",
        toolName: "exec",
        code: "SYSTEM_RUN_DENIED",
        message: denial.error,
        fatalForCron: true,
      });
      expect(backendMocks.runSettledFinalization).toHaveBeenCalledTimes(
        outcome === "unavailable" ? 0 : outcome === "empty" ? 2 : 1,
      );
      for (const [preparedAttempt, settledAttempt] of backendMocks.runSettledFinalization.mock
        .calls) {
        expect(preparedAttempt).toMatchObject({
          disableTools: true,
          skipPreparedUserTurnMessage: true,
          suppressNextUserMessagePersistence: true,
        });
        expect(settledAttempt).toBe(attempt);
      }
      expect(transcriptMocks.appendAssistantMirrorMessageByIdentity).not.toHaveBeenCalled();
      if (outcome === "answered") {
        expect(result.finalizationOutcome).toBe("answered");
        expect(result.prepared.payloadsWithToolMedia).toEqual([
          expect.objectContaining({ text: finalText }),
        ]);
        expect(result.attempt.messagesSnapshot.slice(0, -1)).toEqual(attempt.messagesSnapshot);
      } else {
        expect(result.finalizationOutcome).toBe(
          outcome === "unavailable" ? "not-attempted" : "failed",
        );
        expect(result.attempt).toBe(attempt);
        if (retainProgress) {
          const progress = result.prepared.payloadsWithToolMedia?.find(
            (payload) => !payload.isError,
          );
          expect(getReplyPayloadMetadata(progress ?? {})).toMatchObject({
            assistantMessageIndex: 3,
          });
        } else {
          const warning = result.prepared.payloadsWithToolMedia?.find((payload) => payload.isError);
          expect(warning).toMatchObject({ text: expect.stringContaining("failed"), isError: true });
          expect(getReplyPayloadMetadata(warning ?? {})).toMatchObject({
            toolErrorWarning: { toolName: "exec" },
          });
        }
      }
    },
  );
});
