import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invokeNodeClaudeCliRun } from "../../gateway/node-agent-cli-runtime.js";
import { resetAgentEventsForTest } from "../../infra/agent-events.js";
import { setDiagnosticsEnabledForProcess } from "../../infra/diagnostic-events.js";
import {
  resetDiagnosticRunActivityForTest,
  startDiagnosticRunActivityTracking,
} from "../../logging/diagnostic-run-activity.js";
import type { CliBackendPlugin } from "../../plugins/cli-backend.types.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
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
const { buildAnthropicCliBackend } = await loadBundledPluginFacade<{
  buildAnthropicCliBackend: () => CliBackendPlugin;
}>({ pluginId: "anthropic", artifactBasename: "api.js" });
const anthropicCliBackend = buildAnthropicCliBackend();
const resolveExecutionArgs = anthropicCliBackend.resolveExecutionArgs;

if (!resolveExecutionArgs) {
  throw new Error("Anthropic CLI backend is missing its execution-argument resolver");
}

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
  const normalizeConfig = anthropicCliBackend.normalizeConfig;
  if (!normalizeConfig) {
    throw new Error("Anthropic CLI backend is missing its config normalizer");
  }
  const context = buildPreparedCliRunContext({
    provider: "claude-cli",
    config: { tools: { exec: { mode: "full" } } },
    resolveExecutionArgs,
  });
  Object.assign(
    context.preparedBackend.backend,
    normalizeConfig(context.preparedBackend.backend, {
      backendId: "claude-cli",
      agentId: "main",
      config: context.params.config,
    }),
  );
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

  const spawnInput = supervisorSpawnMock.mock.calls.at(-1)?.[0];
  if (!spawnInput || !("argv" in spawnInput)) {
    throw new Error("Expected the Claude CLI to use a Node process invocation");
  }
  return spawnInput.argv;
}

it("keeps policy-derived bypass on ordinary turns and omits it from native compact argv", async () => {
  const ordinaryArgs = await runCli();
  const compactArgs = await runCli("compact");

  expect(ordinaryArgs).toContain("bypassPermissions");
  expect(compactArgs).not.toContain("bypassPermissions");
});
