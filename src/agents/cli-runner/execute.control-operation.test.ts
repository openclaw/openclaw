import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveClaudeCliExecutionArgs } from "../../../extensions/anthropic/cli-shared.js";
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

async function runCli(controlOperation?: "compact") {
  const context = buildPreparedCliRunContext({
    provider: "claude-cli",
    config: { tools: { exec: { mode: "full" } } },
    resolveExecutionArgs: resolveClaudeCliExecutionArgs,
  });
  if (controlOperation) {
    context.params.controlOperation = controlOperation;
    context.backendResolved.manualCompaction = {
      input: "arg",
      buildPrompt: () => "/compact",
      validateOutput: () => ({ ok: true }),
    };
  }
  supervisorSpawnMock.mockResolvedValueOnce(
    createManagedRun({
      ...createSuccessfulProcessExit(),
      stdout: `${JSON.stringify({ type: "result", result: "ok" })}\n`,
    }),
  );

  await execute(context);

  return supervisorSpawnMock.mock.calls.at(-1)?.[0].argv ?? [];
}

it("keeps policy-derived bypass on ordinary turns and omits it from native compact argv", async () => {
  const ordinaryArgs = await runCli();
  const compactArgs = await runCli("compact");

  expect(ordinaryArgs).toContain("bypassPermissions");
  expect(compactArgs).not.toContain("bypassPermissions");
});
