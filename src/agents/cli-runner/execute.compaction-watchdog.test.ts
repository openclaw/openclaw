import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { waitForDiagnosticEventsDrained } from "../../infra/diagnostic-events.js";
import {
  BLOCKED_TOOL_CALL_ABORT_FLOOR_MS as WORK_GRACE_MS,
  closeDiagnosticEmbeddedRunOwner,
  createDiagnosticEmbeddedRunOwner,
  getDiagnosticSessionActivitySnapshot,
  markDiagnosticEmbeddedRunStarted,
  resolveRunStaleThresholdMs,
} from "../../logging/diagnostic-run-activity.js";
import {
  logSessionStateChange,
  startGatewayDiagnosticHeartbeat,
} from "../../logging/diagnostic.js";
import { resetDiagnosticStateForTest } from "../../logging/diagnostic.test-support.js";
import type { CliBackendParseJsonlLifecycleEvent } from "../../plugins/cli-backend.types.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import * as pluginWatchdog from "./execute-plugin-watchdog.js";
import { waitUntilAborted } from "./execute-plugin.test-support.js";
import { executePreparedCliRun } from "./execute.js";
import {
  createManagedRun,
  supervisorSpawnMock,
  wrapPreparedCliRunWithTestAdmission,
} from "./execute.test-support.js";

const NO_OUTPUT_MS = 180_000;
const HEARTBEAT_MS = 30_000;
const STUCK_SESSION_MS = 360_000;
const START = { type: "system", subtype: "status", status: "compacting" };
const RESULT = { type: "result", subtype: "success", result: "compaction survived" };
const TOOL = {
  type: "assistant",
  message: {
    role: "assistant",
    content: [{ type: "tool_use", id: "tool", name: "Bash", input: { command: "true" } }],
  },
};
const execute = wrapPreparedCliRunWithTestAdmission(executePreparedCliRun);
const owners: ReturnType<typeof createDiagnosticEmbeddedRunOwner>[] = [];
const cleanups: (() => Promise<unknown>)[] = [];

// Backend records enter the real parser-to-watchdog and parser-to-diagnostics paths.
const parseJsonlLifecycleEvent: CliBackendParseJsonlLifecycleEvent = (line) => {
  if (!line.includes("compacting") && !line.includes("compact_result")) {
    return null;
  }
  const record = JSON.parse(line) as Record<string, unknown>;
  if (record.compact_result === "success" || record.compact_result === "failed") {
    return { kind: "compaction", phase: "end", completed: record.compact_result === "success" };
  }
  return record.type === "system" && record.subtype === "status" && record.status === "compacting"
    ? { kind: "compaction", phase: "start" }
    : null;
};

function contextFor(runId: string, noOutputMs = NO_OUTPUT_MS) {
  const context = buildPreparedCliRunContext({
    runId,
    sessionId: runId,
    sessionKey: `agent:main:${runId}`,
    agentId: "main",
    model: "fixture-model",
    config: { plugins: { enabled: false } },
    timeoutMs: 3_600_000,
    backend: {
      command: process.execPath,
      sessionMode: "none",
      reliability: { watchdog: { fresh: { minMs: noOutputMs, maxMs: noOutputMs } } },
    },
  });
  context.backendResolved.bundleMcp = false;
  context.backendResolved.parseJsonlLifecycleEvent = parseJsonlLifecycleEvent;
  return context;
}

function diagnostics(context: ReturnType<typeof contextFor>) {
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
  return recoverStuckSession;
}

const snapshot = (context: ReturnType<typeof contextFor>) =>
  getDiagnosticSessionActivitySnapshot(context.params);

function startCompaction(
  context: ReturnType<typeof contextFor>,
  phase: "success" | "failed" | "stuck" | "tool" = "stuck",
) {
  const started = createDeferred<number>();
  const advance = createDeferred();
  const advanced = createDeferred<number>();
  const finish = createDeferred();
  context.executionTarget = {
    kind: "plugin",
    async *execute(execution) {
      yield START;
      if (phase === "tool") {
        yield TOOL;
      }
      started.resolve(Date.now());
      if (phase !== "stuck") {
        await advance.promise;
        yield phase === "tool"
          ? { type: "stream_event", event: { type: "ping" } }
          : { compact_result: phase };
        advanced.resolve(Date.now());
      }
      await Promise.race([waitUntilAborted(execution), finish.promise]);
      yield RESULT;
    },
  };
  const settled = vi.fn();
  const run = execute(context).finally(settled);
  void run.catch(() => {});
  cleanups.push(async () => {
    advance.resolve();
    finish.resolve();
    await Promise.allSettled([run]);
  });
  return { run, started, advance, advanced, finish, settled };
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  vi.setSystemTime(Date.parse("2026-09-24T00:00:00Z"));
});
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  for (const owner of owners.splice(0)) {
    closeDiagnosticEmbeddedRunOwner(owner);
  }
  supervisorSpawnMock.mockReset();
  vi.restoreAllMocks();
  resetDiagnosticStateForTest();
  vi.useRealTimers();
});

it.each(["success", "failed"] as const)("releases compaction liveness after %s", async (phase) => {
  const context = contextFor(`compaction-${phase}`, phase === "success" ? NO_OUTPUT_MS : 1_000);
  const recover = phase === "success" ? diagnostics(context) : undefined;
  const { run, started, advance, advanced, finish } = startCompaction(context, phase);
  const startedAt = await started.promise;
  if (phase === "failed") {
    advance.resolve();
    await advanced.promise;
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(run).rejects.toThrow("produced no output");
    return;
  }
  // Beyond the reported 180,444ms silence and the ordinary 180s watchdog.
  await vi.advanceTimersByTimeAsync(240_000);
  expect(recover).not.toHaveBeenCalled();
  expect(snapshot(context)).toMatchObject({
    activeBackendLivenessDeadlineAtMs: startedAt + WORK_GRACE_MS,
    lastProgressAgeMs: 240_000,
  });
  advance.resolve();
  const clearedAt = await advanced.promise;
  expect(snapshot(context)).toMatchObject({
    activeBackendLivenessDeadlineAtMs: clearedAt + NO_OUTPUT_MS,
  });
  finish.resolve();
  await expect(run).resolves.toMatchObject({ text: RESULT.result });
  await waitForDiagnosticEventsDrained();
  expect(snapshot(context).activeBackendLivenessDeadlineAtMs).toBeUndefined();
});

it("requests diagnostics recovery when compaction never ends", async () => {
  const context = contextFor("compaction-stuck");
  const recover = diagnostics(context);
  // Silence only the competing watchdog so recovery is observed at its own heartbeat.
  const createWatchdog = pluginWatchdog.createCliPluginWatchdog;
  vi.spyOn(pluginWatchdog, "createCliPluginWatchdog").mockImplementationOnce((params) => {
    const watchdog = createWatchdog(params);
    watchdog.dispose();
    return watchdog;
  });
  const { run, started, finish } = startCompaction(context);
  await started.promise;
  await vi.advanceTimersByTimeAsync(WORK_GRACE_MS - HEARTBEAT_MS);
  expect(recover).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(2 * HEARTBEAT_MS);
  expect(recover).toHaveBeenCalled();
  expect(recover.mock.calls[0]?.[0]).toMatchObject({
    sessionId: context.params.sessionId,
    sessionKey: context.params.sessionKey,
    allowActiveAbort: true,
  });
  expect(STUCK_SESSION_MS).toBeLessThan(WORK_GRACE_MS);
  finish.resolve();
  await run;
});

it("bounds compaction silence from the last record while a parsed tool is active", async () => {
  const context = contextFor("quiet-clock-tool");
  diagnostics(context);
  const flow = startCompaction(context, "tool");
  const startedAt = await flow.started.promise;
  await vi.advanceTimersByTimeAsync(0);
  await waitForDiagnosticEventsDrained();
  const activity = snapshot(context);
  expect(activity).toMatchObject({
    activeWorkKind: "tool_call",
    activeBackendLivenessDeadlineAtMs: startedAt + WORK_GRACE_MS,
  });
  expect(
    resolveRunStaleThresholdMs(activity, activity.lastProgressAgeMs ?? 0, STUCK_SESSION_MS),
  ).toBe(WORK_GRACE_MS);
  await vi.advanceTimersByTimeAsync(WORK_GRACE_MS - 60_000);
  expect(flow.settled).not.toHaveBeenCalled();
  flow.advance.resolve();
  await flow.advanced.promise;
  for (const elapsed of [62_000, WORK_GRACE_MS - 64_000]) {
    await vi.advanceTimersByTimeAsync(elapsed);
    expect(flow.settled).not.toHaveBeenCalled();
  }
  await vi.advanceTimersByTimeAsync(4_000);
  expect(flow.settled).toHaveBeenCalledOnce();
  await expect(flow.run).rejects.toMatchObject({
    name: "FailoverError",
    cliTimeout: { mode: "no-output", compactionActive: true, activeToolCount: 1 },
  });
});

it("records streamed compaction on a supervised no-output timeout", async () => {
  const context = contextFor("compaction-supervised", 1_000);
  const stdout = `${JSON.stringify(START)}\n`;
  supervisorSpawnMock.mockImplementationOnce(async (input) => {
    input.onStdout?.(stdout);
    return createManagedRun({
      reason: "no-output-timeout",
      exitCode: null,
      exitSignal: "SIGKILL",
      durationMs: 1_000,
      stdout: input.captureOutput === false ? "" : stdout,
      stderr: "",
      timedOut: true,
      noOutputTimedOut: true,
    });
  });
  await expect(execute(context)).rejects.toMatchObject({
    name: "FailoverError",
    cliTimeout: { mode: "no-output", compactionActive: true },
  });
});
