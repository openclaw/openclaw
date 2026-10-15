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
import { defaultCliWatchdogClock } from "./execute-plugin-watchdog.js";
import { waitUntilAborted } from "./execute-plugin.test-support.js";
import { executePreparedCliRun } from "./execute.js";
import {
  createManagedRun,
  setCliRunnerExecuteTestDeps,
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

function contextFor(
  runId: string,
  noOutputMs = NO_OUTPUT_MS,
  timeoutMs = 3_600_000,
  jsonlDialect?: "claude-stream-json",
) {
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
      ...(jsonlDialect ? { jsonlDialect } : {}),
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

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  vi.setSystemTime(Date.parse("2026-09-24T00:00:00Z"));
});
afterEach(() => {
  for (const owner of owners.splice(0)) {
    closeDiagnosticEmbeddedRunOwner(owner);
  }
  supervisorSpawnMock.mockReset();
  setCliRunnerExecuteTestDeps({ watchdogClock: defaultCliWatchdogClock });
  resetDiagnosticStateForTest();
  vi.useRealTimers();
});

it("releases both liveness allowances after compaction success", async () => {
  const phase = "success";
  const context = contextFor(`compaction-${phase}`);
  const recover = diagnostics(context);
  const started = createDeferred<number>();
  const release = createDeferred();
  const ended = createDeferred<number>();
  const finish = createDeferred();
  context.executionTarget = {
    kind: "plugin",
    async *execute() {
      yield START;
      started.resolve(Date.now());
      await release.promise;
      yield { compact_result: phase };
      ended.resolve(Date.now());
      await finish.promise;
      yield RESULT;
    },
  };
  const run = execute(context);
  try {
    const startedAt = await started.promise;
    // Beyond the reported 180,444ms silence and the ordinary 180s watchdog.
    await vi.advanceTimersByTimeAsync(240_000);
    expect(recover).not.toHaveBeenCalled();
    expect(getDiagnosticSessionActivitySnapshot(context.params)).toMatchObject({
      activeBackendLivenessDeadlineAtMs: startedAt + WORK_GRACE_MS,
      lastProgressAgeMs: 240_000,
    });
    release.resolve();
    const clearedAt = await ended.promise;
    expect(getDiagnosticSessionActivitySnapshot(context.params)).toMatchObject({
      activeBackendLivenessDeadlineAtMs: clearedAt + NO_OUTPUT_MS,
    });
    finish.resolve();
    await expect(run).resolves.toMatchObject({ text: RESULT.result });
    await waitForDiagnosticEventsDrained();
    expect(
      getDiagnosticSessionActivitySnapshot(context.params).activeBackendLivenessDeadlineAtMs,
    ).toBeUndefined();
  } finally {
    release.resolve();
    finish.resolve();
    await Promise.allSettled([run]);
  }
});

it("re-arms the no-output watchdog after compaction failed", async () => {
  const phase = "failed";
  const context = contextFor(`rearm-${phase}`, 1_000);
  const ended = createDeferred();
  context.executionTarget = {
    kind: "plugin",
    async *execute(execution) {
      yield START;
      yield { compact_result: phase };
      ended.resolve();
      await waitUntilAborted(execution);
      yield RESULT;
    },
  };
  const rejection = expect(execute(context)).rejects.toThrow("produced no output");
  await ended.promise;
  await vi.advanceTimersByTimeAsync(2_000);
  await rejection;
});

it("requests diagnostics recovery when compaction never ends", async () => {
  const context = contextFor("compaction-stuck");
  const recover = diagnostics(context);
  // Silence only the competing watchdog so recovery is observed at its own heartbeat.
  setCliRunnerExecuteTestDeps({
    watchdogClock: { now: () => Date.now(), setTimeout: () => () => {} },
  });
  const started = createDeferred();
  const finish = createDeferred();
  context.executionTarget = {
    kind: "plugin",
    async *execute() {
      yield START;
      started.resolve();
      await finish.promise;
      yield RESULT;
    },
  };
  const run = execute(context);
  try {
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
  } finally {
    finish.resolve();
    await Promise.allSettled([run]);
  }
});

it("bounds compaction silence from the last record while a parsed tool is active", async () => {
  const context = contextFor("quiet-clock-tool");
  diagnostics(context);
  const started = createDeferred<number>();
  const ping = createDeferred();
  const pinged = createDeferred();
  const finish = createDeferred();
  context.executionTarget = {
    kind: "plugin",
    async *execute(execution) {
      yield START;
      yield TOOL;
      started.resolve(Date.now());
      await ping.promise;
      yield { type: "stream_event", event: { type: "ping" } };
      pinged.resolve();
      await Promise.race([waitUntilAborted(execution), finish.promise]);
      yield RESULT;
    },
  };
  let settled = false;
  const run = execute(context).finally(() => {
    settled = true;
  });
  const rejection = expect(run).rejects.toMatchObject({
    name: "FailoverError",
    cliTimeout: { mode: "no-output", compactionActive: true, activeToolCount: 1 },
  });
  try {
    const startedAt = await started.promise;
    await vi.advanceTimersByTimeAsync(0);
    await waitForDiagnosticEventsDrained();
    const snapshot = getDiagnosticSessionActivitySnapshot(context.params);
    expect(snapshot).toMatchObject({
      activeWorkKind: "tool_call",
      activeBackendLivenessDeadlineAtMs: startedAt + WORK_GRACE_MS,
    });
    expect(
      resolveRunStaleThresholdMs(snapshot, snapshot.lastProgressAgeMs ?? 0, STUCK_SESSION_MS),
    ).toBe(WORK_GRACE_MS);
    await vi.advanceTimersByTimeAsync(WORK_GRACE_MS - 60_000);
    expect(settled).toBe(false);
    ping.resolve();
    await pinged.promise;
    await vi.advanceTimersByTimeAsync(62_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(WORK_GRACE_MS - 64_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(settled).toBe(true);
    await rejection;
  } finally {
    ping.resolve();
    finish.resolve();
    await Promise.allSettled([run, rejection]);
  }
});

/**
 * Ordinary parent records that spend the cumulative raw-character budget. Two
 * of these cross the 8 MiB limit, so the second is the record that spends it and
 * everything after it takes the post-budget path. `type: "system"` keeps them
 * out of the partial-message exemption and out of binary normalization, so the
 * whole line is charged.
 */
const BUDGET_FILLER = {
  type: "system",
  subtype: "status",
  session_id: "budget-filler",
  filler: "f".repeat(4 * 1024 * 1024 + 1_024),
};

it("grants compaction grace to a compaction that starts past a spent budget", async () => {
  // A subagent-heavy Claude turn spends the parent budget and then compacts.
  // Assembly is over, but the watchdog still has to see both phases: without the
  // start it kills a healthy silent compaction at the ordinary no-output
  // deadline, and without the end it holds a grace the turn no longer has.
  const context = contextFor(
    "compaction-post-budget",
    NO_OUTPUT_MS,
    3_600_000,
    "claude-stream-json",
  );
  const recover = diagnostics(context);
  const started = createDeferred<number>();
  const release = createDeferred();
  const ended = createDeferred<number>();
  const finish = createDeferred();
  context.executionTarget = {
    kind: "plugin",
    async *execute() {
      yield BUDGET_FILLER;
      yield BUDGET_FILLER;
      yield START;
      started.resolve(Date.now());
      await release.promise;
      yield { compact_result: "success" };
      ended.resolve(Date.now());
      await finish.promise;
      yield RESULT;
    },
  };
  const run = execute(context);
  let settled = false;
  const markSettled = () => {
    settled = true;
  };
  // Also absorbs the control's rejection so the abort surfaces as this flag.
  void run.then(markSettled, markSettled);
  try {
    const startedAt = await started.promise;
    await vi.advanceTimersByTimeAsync(240_000);
    // The behavioral fact first: with the start phase lost the ordinary 180s
    // no-output deadline terminates this healthy turn.
    expect(settled).toBe(false);
    expect(recover).not.toHaveBeenCalled();
    expect(getDiagnosticSessionActivitySnapshot(context.params)).toMatchObject({
      activeBackendLivenessDeadlineAtMs: startedAt + WORK_GRACE_MS,
      lastProgressAgeMs: 240_000,
    });
    release.resolve();
    const clearedAt = await ended.promise;
    // The stuck-flag direction: the end phase re-arms the ordinary watchdog.
    expect(getDiagnosticSessionActivitySnapshot(context.params)).toMatchObject({
      activeBackendLivenessDeadlineAtMs: clearedAt + NO_OUTPUT_MS,
    });
    finish.resolve();
    // Text assembly never resumes, yet the finished turn is still recovered.
    await expect(run).resolves.toMatchObject({ text: RESULT.result });
  } finally {
    release.resolve();
    finish.resolve();
    await Promise.allSettled([run]);
  }
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
