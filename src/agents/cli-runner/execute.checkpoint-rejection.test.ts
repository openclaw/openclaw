import { afterEach, expect, it } from "vitest";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import { executePreparedCliRun } from "./execute.js";
import {
  createManagedRun,
  createSuccessfulProcessExit,
  supervisorSpawnMock,
  wrapPreparedCliRunWithTestAdmission,
} from "./execute.test-support.js";

// Claude Code 2.1.305 rejects a compacted-away --resume-session-at checkpoint
// with this terminal result record (openclaw/openclaw#181254).
const CHECKPOINT_UUID = "11111111-2222-3333-4444-555555555555";
const REJECTION_RECORD =
  JSON.stringify({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    num_turns: 0,
    session_id: "fork-successor",
    errors: [`No message found with message.uuid of: ${CHECKPOINT_UUID}`],
  }) + "\n";

function buildForkFirstTurnContext() {
  const context = buildPreparedCliRunContext({
    provider: "claude-cli",
    runId: "checkpoint-rejection",
    backend: {
      command: "claude",
      args: ["-p", "--output-format", "stream-json"],
      resumeArgs: ["-p", "--output-format", "stream-json", "--resume", "{sessionId}"],
      forkArg: "--fork-session",
      resumeAtArg: "--resume-session-at",
      output: "jsonl",
      input: "stdin",
      systemPromptFileArg: undefined,
    },
  });
  context.backendResolved.bundleMcp = false;
  context.params.cliSessionResumeAt = CHECKPOINT_UUID;
  return context;
}

afterEach(() => {
  supervisorSpawnMock.mockReset();
});

it("classifies a rejected resume checkpoint as an expired session when the CLI exits nonzero", async () => {
  const context = buildForkFirstTurnContext();
  supervisorSpawnMock.mockResolvedValueOnce(
    createManagedRun({ ...createSuccessfulProcessExit(), exitCode: 1, stdout: REJECTION_RECORD }),
  );

  await expect(
    wrapPreparedCliRunWithTestAdmission(executePreparedCliRun)(context, "parent-session"),
  ).rejects.toMatchObject({ reason: "session_expired", code: "cli_resume_at_unsupported" });
});

it("classifies the same rejection on the structured-result path after a clean exit", async () => {
  const context = buildForkFirstTurnContext();
  supervisorSpawnMock.mockResolvedValueOnce(
    createManagedRun({ ...createSuccessfulProcessExit(), stdout: REJECTION_RECORD }),
  );

  await expect(
    wrapPreparedCliRunWithTestAdmission(executePreparedCliRun)(context, "parent-session"),
  ).rejects.toMatchObject({ reason: "session_expired", code: "cli_resume_at_unsupported" });
});

it("still classifies the rejection after the CLI produced observable activity", async () => {
  const context = buildForkFirstTurnContext();
  const assistantEvent =
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "partial work" }] },
      session_id: "fork-successor",
    }) + "\n";
  supervisorSpawnMock.mockResolvedValueOnce(
    createManagedRun({
      ...createSuccessfulProcessExit(),
      exitCode: 1,
      stdout: assistantEvent + REJECTION_RECORD,
    }),
  );

  await expect(
    wrapPreparedCliRunWithTestAdmission(executePreparedCliRun)(context, "parent-session"),
  ).rejects.toMatchObject({ reason: "session_expired", code: "cli_resume_at_unsupported" });
});
