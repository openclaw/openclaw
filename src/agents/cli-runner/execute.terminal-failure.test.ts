import { afterEach, expect, it, vi } from "vitest";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import { executePreparedCliRun } from "./execute.js";
import {
  createManagedRun,
  createSuccessfulProcessExit,
  supervisorSpawnMock,
  wrapPreparedCliRunWithTestAdmission,
} from "./execute.test-support.js";

afterEach(() => {
  supervisorSpawnMock.mockReset();
});

it("records a CLI terminal stop before backend error classification can replace it", async () => {
  const context = buildPreparedCliRunContext({
    provider: "claude-cli",
    runId: "terminal-classification",
    backend: {
      command: "agent-cli",
      args: [],
      output: "jsonl",
      input: "stdin",
      systemPromptFileArg: undefined,
    },
  });
  context.backendResolved.bundleMcp = false;
  const classifyErrorCode = vi.fn(() => {
    throw new Error("terminal stops must bypass backend error classification");
  });
  context.backendResolved.classifyErrorCode = classifyErrorCode;
  supervisorSpawnMock.mockResolvedValueOnce(
    createManagedRun({
      ...createSuccessfulProcessExit(),
      exitCode: 1,
      stdout:
        JSON.stringify({
          type: "result",
          subtype: "error_max_turns",
          session_id: "terminal-session",
          terminal_reason: "max_turns",
          errors: ["Reached maximum number of turns (1)"],
        }) + "\n",
    }),
  );

  await expect(
    wrapPreparedCliRunWithTestAdmission(executePreparedCliRun)(context),
  ).rejects.toMatchObject({ code: "cli_max_turns", reason: "unknown" });
  expect(classifyErrorCode).not.toHaveBeenCalled();
});
