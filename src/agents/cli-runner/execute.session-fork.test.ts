import { afterEach, expect, it } from "vitest";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import { executePreparedCliRun } from "./execute.js";
import {
  createManagedRun,
  createSuccessfulProcessExit,
  supervisorSpawnMock,
  wrapPreparedCliRunWithTestAdmission,
} from "./execute.test-support.js";

const CHECKPOINT = "11111111-2222-3333-4444-555555555555";

const stream = (sessionId: string) =>
  [
    { type: "system", subtype: "init", session_id: sessionId },
    {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "fork answer" }] },
      session_id: sessionId,
    },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "fork answer",
      session_id: sessionId,
    },
  ]
    .map((record) => JSON.stringify(record))
    .join("\n") + "\n";

/** A hidden session fork: no fork marker to claim and no successor to persist. */
function buildSessionForkContext() {
  const context = buildPreparedCliRunContext({
    provider: "claude-cli",
    runId: "session-fork",
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
  context.params.controlOperation = "fork";
  context.params.forkCliSessionOnResume = true;
  context.params.cliSessionResumeAt = CHECKPOINT;
  return context;
}

const run = wrapPreparedCliRunWithTestAdmission(executePreparedCliRun);

afterEach(() => {
  supervisorSpawnMock.mockReset();
});

it("branches the source native session at the checkpoint and keeps no successor", async () => {
  const context = buildSessionForkContext();
  supervisorSpawnMock.mockResolvedValueOnce(
    createManagedRun({ ...createSuccessfulProcessExit(), stdout: stream("fork-successor") }),
  );

  await expect(run(context, "parent-session")).resolves.toMatchObject({
    text: "fork answer",
    sessionId: "fork-successor",
  });
  const spawn = supervisorSpawnMock.mock.calls[0]?.[0];
  expect(spawn?.mode === "child" ? spawn.argv : undefined).toEqual(
    expect.arrayContaining([
      "--resume",
      "parent-session",
      "--fork-session",
      "--resume-session-at",
      CHECKPOINT,
    ]),
  );
});

it("fails a session fork whose CLI did not branch into a successor session", async () => {
  const context = buildSessionForkContext();
  supervisorSpawnMock.mockResolvedValueOnce(
    createManagedRun({ ...createSuccessfulProcessExit(), stdout: stream("parent-session") }),
  );

  await expect(run(context, "parent-session")).rejects.toThrow(
    "forked CLI session did not report a successor session id",
  );
});

it("refuses a session fork without a native session to resume", async () => {
  const context = buildSessionForkContext();

  await expect(run(context, undefined)).rejects.toThrow(
    "CLI session fork needs a resumable native session",
  );
  expect(supervisorSpawnMock).not.toHaveBeenCalled();
});
