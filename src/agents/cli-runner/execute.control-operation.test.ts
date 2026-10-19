import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invokeNodeClaudeCliRun } from "../../gateway/node-agent-cli-runtime.js";
import { resetAgentEventsForTest } from "../../infra/agent-events.js";
import { setDiagnosticsEnabledForProcess } from "../../infra/diagnostic-events.js";
import {
  resetDiagnosticRunActivityForTest,
  startDiagnosticRunActivityTracking,
} from "../../logging/diagnostic-run-activity.js";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import { executePreparedCliRun } from "./execute.js";
import {
  createManagedRun,
  createSuccessfulProcessExit,
  setCliRunnerExecuteTestDeps,
  supervisorSpawnMock,
  wrapPreparedCliRunWithTestAdmission,
} from "./execute.test-support.js";
import { writeCliSystemPromptFile } from "./helpers.js";

const execute = wrapPreparedCliRunWithTestAdmission(executePreparedCliRun);

beforeEach(() => {
  setDiagnosticsEnabledForProcess(true);
  resetAgentEventsForTest();
  resetDiagnosticRunActivityForTest();
  startDiagnosticRunActivityTracking();
  setCliRunnerExecuteTestDeps({ writeCliSystemPromptFile, invokeNodeClaudeCliRun });
  supervisorSpawnMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetDiagnosticRunActivityForTest();
});

it("passes native compaction through to backend argument resolution", async () => {
  const context = buildPreparedCliRunContext({ provider: "claude-cli" });
  context.params.controlOperation = "compact";
  context.backendResolved.manualCompaction = {
    input: "arg",
    buildPrompt: () => "/compact",
    validateOutput: () => ({ ok: true }),
  };
  const resolveExecutionArgs = vi.fn(
    (args: Parameters<NonNullable<typeof context.backendResolved.resolveExecutionArgs>>[0]) =>
      args.baseArgs,
  );
  context.backendResolved.resolveExecutionArgs = resolveExecutionArgs;
  supervisorSpawnMock.mockResolvedValueOnce(
    createManagedRun({
      ...createSuccessfulProcessExit(),
      stdout: `${JSON.stringify({ type: "result", result: "ok" })}\n`,
    }),
  );

  await execute(context);

  expect(resolveExecutionArgs).toHaveBeenCalledWith(
    expect.objectContaining({
      agentId: context.params.agentId,
      controlOperation: "compact",
    }),
  );
});
