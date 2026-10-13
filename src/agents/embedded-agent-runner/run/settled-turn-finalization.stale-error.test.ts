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
}));
vi.mock("../../harness/selection.js", () => ({
  runAgentHarnessSettledTurnFinalization: backendMocks.runSettledFinalization,
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

  it.each([
    { outcome: "answered", retainProgress: true },
    { outcome: "failed", retainProgress: false },
  ] as const)(
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
      const finalText = "The command was denied. The file contains the requested value.";
      if (outcome === "failed") {
        backendMocks.runSettledFinalization.mockRejectedValueOnce(
          new Error("finalizer unavailable"),
        );
      } else {
        backendMocks.runSettledFinalization.mockResolvedValue({
          outcome,
          result: {
            assistant: buildEmbeddedRunnerAssistant({
              content: [{ type: "text", text: finalText }],
            }),
          },
        });
      }

      const result = await prepareTerminalWithSettledTurnFinalization(input);

      expect(attempt.lastToolError).toBe(denial);
      expect(result.prepared.attemptToolSummary).toMatchObject({
        unresolvedError: { toolName: "exec" },
      });
      expect(result.prepared.failureSignal).toEqual({
        kind: "execution_denied",
        source: "tool",
        toolName: "exec",
        code: "SYSTEM_RUN_DENIED",
        message: denial.error,
        fatalForCron: true,
      });
      expect(backendMocks.runSettledFinalization).toHaveBeenCalledOnce();
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
        expect(result.finalizationOutcome).toBe("failed");
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
