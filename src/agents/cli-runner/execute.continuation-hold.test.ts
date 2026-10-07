import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  BLOCKED_TOOL_CALL_ABORT_FLOOR_MS as WORK_GRACE_MS,
  closeDiagnosticEmbeddedRunOwner,
  createDiagnosticEmbeddedRunOwner,
  markDiagnosticEmbeddedRunStarted,
} from "../../logging/diagnostic-run-activity.js";
import {
  logSessionStateChange,
  startGatewayDiagnosticHeartbeat,
} from "../../logging/diagnostic.js";
import { resetDiagnosticStateForTest } from "../../logging/diagnostic.test-support.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import { waitUntilAborted } from "./execute-plugin.test-support.js";
import { executePreparedCliRun } from "./execute.js";
import { wrapPreparedCliRunWithTestAdmission } from "./execute.test-support.js";

const NO_OUTPUT_MS = 180_000;
const HEARTBEAT_MS = 30_000;
const ANSWER = {
  type: "result",
  subtype: "success",
  result: "Validation started; I'll report when it finishes.",
  openclaw_interim_result: true,
};
const execute = wrapPreparedCliRunWithTestAdmission(executePreparedCliRun);
const owners: ReturnType<typeof createDiagnosticEmbeddedRunOwner>[] = [];

function contextFor(runId: string, timeoutMs: number) {
  const context = buildPreparedCliRunContext({
    runId,
    sessionId: runId,
    sessionKey: `agent:main:${runId}`,
    agentId: "main",
    model: "fixture-model",
    config: { plugins: { enabled: false } },
    timeoutMs,
    backend: {
      command: process.execPath,
      sessionMode: "none",
      reliability: { watchdog: { fresh: { minMs: NO_OUTPUT_MS, maxMs: NO_OUTPUT_MS } } },
    },
  });
  context.backendResolved.bundleMcp = false;
  const recoverStuckSession = vi.fn();
  startGatewayDiagnosticHeartbeat(
    createTestGatewayScheduler("fake-timers"),
    { diagnostics: { enabled: true } },
    { recoverStuckSession },
  );
  const owner = createDiagnosticEmbeddedRunOwner(context.params);
  owners.push(owner);
  context.params.diagnosticOwner = owner;
  logSessionStateChange({ ...context.params, state: "processing" });
  markDiagnosticEmbeddedRunStarted({ ...context.params, owner });
  return { context, recoverStuckSession };
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  vi.setSystemTime(Date.parse("2026-10-06T18:36:00Z"));
});
afterEach(() => {
  for (const owner of owners.splice(0)) {
    closeDiagnosticEmbeddedRunOwner(owner);
  }
  resetDiagnosticStateForTest();
  vi.useRealTimers();
});

it("waits past both watchdogs for a background shell after the answer", async () => {
  const { context, recoverStuckSession } = contextFor("held-answer", 4 * 60 * 60_000);
  const answered = createDeferred();
  const shellFinished = createDeferred();
  context.executionTarget = {
    kind: "plugin",
    async *execute() {
      yield ANSWER;
      // The held shell leaves the live task list before its notification arrives.
      yield { type: "system", subtype: "background_tasks_changed", tasks: [] };
      // A background agent streams its own work and Bash on the main stream without
      // continuing the parent (Claude Code 2.1.284 live capture).
      const subagent = { parent_tool_use_id: "toolu-background-agent" };
      yield {
        type: "assistant",
        ...subagent,
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "subagent-tool", name: "Bash", input: {} }],
        },
      };
      yield { type: "system", subtype: "task_progress", task_id: "background-agent" };
      yield {
        type: "user",
        ...subagent,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "subagent-tool", content: "" }],
        },
      };
      yield {
        type: "system",
        subtype: "task_started",
        task_id: "subagent-bash",
        owned_by_subagent: true,
      };
      yield { type: "system", subtype: "task_notification", task_id: "subagent-bash" };
      answered.resolve();
      await shellFinished.promise;
      yield { type: "system", subtype: "task_notification", task_id: "long-shell" };
      yield { type: "result", subtype: "success", result: "Validation passed." };
    },
  };
  const run = execute(context);
  try {
    await answered.promise;
    await vi.advanceTimersByTimeAsync(WORK_GRACE_MS + 2 * HEARTBEAT_MS);
    expect(recoverStuckSession).not.toHaveBeenCalled();

    shellFinished.resolve();
    const output = await run;
    expect(output.textParts).toEqual([ANSWER.result, "Validation passed."]);
    expect(output.terminalInterruption).toBeUndefined();
  } finally {
    shellFinished.resolve();
    await Promise.allSettled([run]);
  }
});

it.each([
  { name: "the overall deadline ends the wait", timeoutMs: 60_000, continuation: [] },
  {
    name: "a started continuation goes silent",
    timeoutMs: 4 * 60 * 60_000,
    continuation: [{ type: "system", subtype: "task_notification", task_id: "long-shell" }],
  },
])("returns the committed answer when $name", async (testCase) => {
  const { context } = contextFor("held-answer-deadline", testCase.timeoutMs);
  context.executionTarget = {
    kind: "plugin",
    async *execute(execution) {
      yield ANSWER;
      yield* testCase.continuation;
      await waitUntilAborted(execution);
    },
  };
  const run = execute(context);

  await vi.advanceTimersByTimeAsync(NO_OUTPUT_MS + 1_000);

  await expect(run).resolves.toMatchObject({
    text: ANSWER.result,
    terminalInterruption: { reason: "timeout" },
  });
});
