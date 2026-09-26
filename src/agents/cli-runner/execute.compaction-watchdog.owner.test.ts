/**
 * Owner B coverage: native compaction has two independent liveness owners, and
 * the CLI no-output watchdog is only one of them. The diagnostics stuck-session
 * recovery timer runs on its own clock and will abort a quiet run even when the
 * watchdog has deferred, so compaction must reach it too.
 *
 * Nothing here injects a `compactionActive` getter, an `onCompactionActiveChange`
 * listener, or an `onOutstandingWorkChange` double. The compaction state is
 * streamed as a backend record and the only thing carrying it to the diagnostics
 * owner is the wiring inside `executeCliProcess`, so deleting either hop turns
 * these cases red. The owner itself is the real `beginDiagnosticBackendActivity`
 * registration, observed through the same snapshot the recovery timer reads.
 */
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { waitForDiagnosticEventsDrained } from "../../infra/diagnostic-events.js";
import {
  BLOCKED_TOOL_CALL_ABORT_FLOOR_MS,
  closeDiagnosticEmbeddedRunOwner,
  createDiagnosticEmbeddedRunOwner,
  getDiagnosticSessionActivitySnapshot,
  markDiagnosticEmbeddedRunStarted,
  resolveRunStaleThresholdMs,
} from "../../logging/diagnostic-run-activity.js";
import { logSessionStateChange, startDiagnosticHeartbeat } from "../../logging/diagnostic.js";
import { resetDiagnosticStateForTest } from "../../logging/diagnostic.test-support.js";
import type { CliBackendParseJsonlLifecycleEvent } from "../../plugins/cli-backend.types.js";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import { type CliWatchdogClock, defaultCliWatchdogClock } from "./execute-plugin-watchdog.js";
import { executePreparedCliRun } from "./execute.js";
import {
  setCliRunnerExecuteTestDeps,
  wrapPreparedCliRunWithTestAdmission,
} from "./execute.test-support.js";

/** The production ceiling a resumed claude-cli turn actually runs with. */
const NO_OUTPUT_TIMEOUT_MS = 180_000;
/** Longer than the no-output budget, and short of the stuck-session abort floor. */
const QUIET_ADVANCE_MS = 240_000;
/** `resolveStuckSessionAbortMs` in `diagnostic.ts`: max(5 minutes, 3 x the 120s warn). */
const STUCK_SESSION_ABORT_MS = 360_000;
/** `DIAGNOSTIC_HEARTBEAT_INTERVAL_MS` in `diagnostic.ts`. */
const HEARTBEAT_INTERVAL_MS = 30_000;
/**
 * A plugin watchdog clock that never ticks. The watchdog is the other liveness
 * owner and would end a compaction-only stall at the grace floor before diagnostics
 * recovery gets its turn, so a case observing the diagnostics owner alone mutes it.
 */
const silencedWatchdogClock: CliWatchdogClock = {
  now: () => Date.now(),
  setTimeout: () => () => {},
};
const COMPACTION_START = { type: "system", subtype: "status", status: "compacting" };
const COMPACTION_END = { compact_result: "success" };

/** Mirrors `parseClaudeCliJsonlLifecycleEvent`; live-proven in extensions/anthropic. */
const parseJsonlLifecycleEvent: CliBackendParseJsonlLifecycleEvent = (line) => {
  if (!line.includes("compacting") && !line.includes("compact_result")) {
    return null;
  }
  const record = JSON.parse(line) as Record<string, unknown>;
  if (record.compact_result === "success" || record.compact_result === "failed") {
    return { kind: "compaction", phase: "end", completed: record.compact_result === "success" };
  }
  if (record.type === "system" && record.subtype === "status") {
    return record.status === "compacting" ? { kind: "compaction", phase: "start" } : null;
  }
  return null;
};

afterEach(() => {
  setCliRunnerExecuteTestDeps({ watchdogClock: defaultCliWatchdogClock });
  resetDiagnosticStateForTest();
  vi.useRealTimers();
});

it("holds the diagnostics recovery deadline open across a streamed compaction", async () => {
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  vi.setSystemTime(Date.parse("2026-09-24T00:00:00Z"));
  const recoverStuckSession = vi.fn();
  startDiagnosticHeartbeat({ diagnostics: { enabled: true } }, { recoverStuckSession });
  const context = buildPreparedCliRunContext({
    runId: "compaction-owner-run",
    sessionId: "compaction-owner-session",
    sessionKey: "agent:main:compaction-owner",
    agentId: "main",
    model: "fixture-model",
    config: { plugins: { enabled: false } },
    timeoutMs: 1_800_000,
    backend: {
      command: process.execPath,
      sessionMode: "none",
      reliability: {
        watchdog: { fresh: { minMs: NO_OUTPUT_TIMEOUT_MS, maxMs: NO_OUTPUT_TIMEOUT_MS } },
      },
    },
  });
  context.backendResolved.bundleMcp = false;
  context.backendResolved.parseJsonlLifecycleEvent = parseJsonlLifecycleEvent;
  const started = createDeferred<number>();
  const release = createDeferred();
  const ended = createDeferred<number>();
  const finish = createDeferred();
  context.executionTarget = {
    kind: "plugin",
    async *execute() {
      yield COMPACTION_START;
      started.resolve(Date.now());
      await release.promise;
      yield COMPACTION_END;
      ended.resolve(Date.now());
      await finish.promise;
      yield { type: "result", subtype: "success", result: "compaction survived" };
    },
  };
  const owner = createDiagnosticEmbeddedRunOwner(context.params);
  context.params.diagnosticOwner = owner;
  logSessionStateChange({ ...context.params, state: "processing" });
  markDiagnosticEmbeddedRunStarted({ ...context.params, owner });

  const run = wrapPreparedCliRunWithTestAdmission(executePreparedCliRun)(context);
  try {
    const startedAt = await started.promise;
    await vi.advanceTimersByTimeAsync(QUIET_ADVANCE_MS);

    // The recovery timer owns its own clock: a deferred watchdog does not stop it.
    expect(recoverStuckSession).not.toHaveBeenCalled();
    // Compaction reaches this owner as ordinary outstanding work, so it holds the same
    // blocked-tool floor a latched tool call holds. No compaction-specific value is
    // carried across the hop for anyone to tune.
    expect(getDiagnosticSessionActivitySnapshot(context.params)).toMatchObject({
      activeBackendLivenessDeadlineAtMs: startedAt + BLOCKED_TOOL_CALL_ABORT_FLOOR_MS,
      lastProgressAgeMs: QUIET_ADVANCE_MS,
    });

    release.resolve();
    const clearedAt = await ended.promise;
    // The end record must hand the allowance back, not leave it latched open.
    expect(getDiagnosticSessionActivitySnapshot(context.params)).toMatchObject({
      activeBackendLivenessDeadlineAtMs: clearedAt + NO_OUTPUT_TIMEOUT_MS,
    });

    finish.resolve();
    await expect(run).resolves.toMatchObject({ text: "compaction survived" });
    await waitForDiagnosticEventsDrained();
    expect(
      getDiagnosticSessionActivitySnapshot(context.params).activeBackendLivenessDeadlineAtMs,
    ).toBeUndefined();
  } finally {
    release.resolve();
    finish.resolve();
    await Promise.allSettled([run]);
    closeDiagnosticEmbeddedRunOwner(owner);
  }
});

it("hands the diagnostics allowance back when a streamed compaction fails", async () => {
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  vi.setSystemTime(Date.parse("2026-09-24T00:00:00Z"));
  const recoverStuckSession = vi.fn();
  startDiagnosticHeartbeat({ diagnostics: { enabled: true } }, { recoverStuckSession });
  const context = buildPreparedCliRunContext({
    runId: "compaction-owner-failed-run",
    sessionId: "compaction-owner-failed-session",
    sessionKey: "agent:main:compaction-owner-failed",
    agentId: "main",
    model: "fixture-model",
    config: { plugins: { enabled: false } },
    timeoutMs: 1_800_000,
    backend: {
      command: process.execPath,
      sessionMode: "none",
      reliability: {
        watchdog: { fresh: { minMs: NO_OUTPUT_TIMEOUT_MS, maxMs: NO_OUTPUT_TIMEOUT_MS } },
      },
    },
  });
  context.backendResolved.bundleMcp = false;
  context.backendResolved.parseJsonlLifecycleEvent = parseJsonlLifecycleEvent;
  const ended = createDeferred<number>();
  const finish = createDeferred();
  context.executionTarget = {
    kind: "plugin",
    async *execute() {
      yield COMPACTION_START;
      // A compaction that fails still ends. Only a successful result clearing the
      // allowance would leave a failed compaction holding it until the run exits.
      yield { compact_result: "failed" };
      ended.resolve(Date.now());
      await finish.promise;
      yield { type: "result", subtype: "success", result: "failed compaction released" };
    },
  };
  const owner = createDiagnosticEmbeddedRunOwner(context.params);
  context.params.diagnosticOwner = owner;
  logSessionStateChange({ ...context.params, state: "processing" });
  markDiagnosticEmbeddedRunStarted({ ...context.params, owner });

  const run = wrapPreparedCliRunWithTestAdmission(executePreparedCliRun)(context);
  try {
    const clearedAt = await ended.promise;
    expect(getDiagnosticSessionActivitySnapshot(context.params)).toMatchObject({
      activeBackendLivenessDeadlineAtMs: clearedAt + NO_OUTPUT_TIMEOUT_MS,
    });

    finish.resolve();
    await expect(run).resolves.toMatchObject({ text: "failed compaction released" });
  } finally {
    finish.resolve();
    await Promise.allSettled([run]);
    closeDiagnosticEmbeddedRunOwner(owner);
  }
});

it("requests recovery for a compaction that never ends once the stuck-session floor is spent", async () => {
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  vi.setSystemTime(Date.parse("2026-09-24T00:00:00Z"));
  const recoverStuckSession = vi.fn();
  startDiagnosticHeartbeat({ diagnostics: { enabled: true } }, { recoverStuckSession });
  // The watchdog would kill this run at the grace floor first. Muting its
  // clock is the only double here: the compaction still streams as a backend record
  // and reaches diagnostics through the real wiring, so this is the outcome the
  // snapshot deadline above stands in for, observed directly.
  setCliRunnerExecuteTestDeps({ watchdogClock: silencedWatchdogClock });
  const context = buildPreparedCliRunContext({
    runId: "compaction-owner-stuck-run",
    sessionId: "compaction-owner-stuck-session",
    sessionKey: "agent:main:compaction-owner-stuck",
    agentId: "main",
    model: "fixture-model",
    config: { plugins: { enabled: false } },
    timeoutMs: 1_800_000,
    backend: {
      command: process.execPath,
      sessionMode: "none",
      reliability: {
        watchdog: { fresh: { minMs: NO_OUTPUT_TIMEOUT_MS, maxMs: NO_OUTPUT_TIMEOUT_MS } },
      },
    },
  });
  context.backendResolved.bundleMcp = false;
  context.backendResolved.parseJsonlLifecycleEvent = parseJsonlLifecycleEvent;
  const started = createDeferred();
  const finish = createDeferred();
  context.executionTarget = {
    kind: "plugin",
    async *execute() {
      yield COMPACTION_START;
      started.resolve();
      // No end record ever arrives: this compaction is wedged.
      await finish.promise;
      yield { type: "result", subtype: "success", result: "released by the test" };
    },
  };
  const owner = createDiagnosticEmbeddedRunOwner(context.params);
  context.params.diagnosticOwner = owner;
  logSessionStateChange({ ...context.params, state: "processing" });
  markDiagnosticEmbeddedRunStarted({ ...context.params, owner });

  const run = wrapPreparedCliRunWithTestAdmission(executePreparedCliRun)(context);
  try {
    await started.promise;
    // Diagnostics reclaims a compaction-only stall at max(stuck-session abort floor,
    // the backend allowance), which compaction now inherits from outstanding work: the
    // last heartbeat before the blocked-tool floor must stay quiet...
    await vi.advanceTimersByTimeAsync(BLOCKED_TOOL_CALL_ABORT_FLOOR_MS - HEARTBEAT_INTERVAL_MS);
    expect(recoverStuckSession).not.toHaveBeenCalled();

    // ...and the first heartbeat past it must ask for recovery. This is the accepted
    // cost of deleting the cap: a wedged compaction is reclaimed on the same clock as
    // a wedged tool call, not on an earlier compaction-only one.
    await vi.advanceTimersByTimeAsync(2 * HEARTBEAT_INTERVAL_MS);
    expect(recoverStuckSession).toHaveBeenCalled();
    expect(recoverStuckSession.mock.calls[0]?.[0]).toMatchObject({
      sessionId: "compaction-owner-stuck-session",
      sessionKey: "agent:main:compaction-owner-stuck",
      allowActiveAbort: true,
    });
    // The stuck-session floor alone would not have reclaimed it: the wider backend
    // allowance is what held recovery off, which is the hop this case covers.
    expect(STUCK_SESSION_ABORT_MS).toBeLessThan(BLOCKED_TOOL_CALL_ABORT_FLOOR_MS);
  } finally {
    finish.resolve();
    await Promise.allSettled([run]);
    closeDiagnosticEmbeddedRunOwner(owner);
  }
});

it("keeps a parsed tool in flight during compaction on the tool clock", async () => {
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  vi.setSystemTime(Date.parse("2026-09-24T00:00:00Z"));
  // The heartbeat is what subscribes run-activity tracking to tool.execution.started.
  startDiagnosticHeartbeat({ diagnostics: { enabled: true } }, { recoverStuckSession: vi.fn() });
  const context = buildPreparedCliRunContext({
    runId: "compaction-owner-tool-run",
    sessionId: "compaction-owner-tool-session",
    sessionKey: "agent:main:compaction-owner-tool",
    agentId: "main",
    model: "fixture-model",
    config: { plugins: { enabled: false } },
    timeoutMs: 1_800_000,
    backend: {
      command: process.execPath,
      sessionMode: "none",
      reliability: {
        watchdog: { fresh: { minMs: NO_OUTPUT_TIMEOUT_MS, maxMs: NO_OUTPUT_TIMEOUT_MS } },
      },
    },
  });
  context.backendResolved.bundleMcp = false;
  context.backendResolved.parseJsonlLifecycleEvent = parseJsonlLifecycleEvent;
  const started = createDeferred<number>();
  const finish = createDeferred();
  context.executionTarget = {
    kind: "plugin",
    async *execute() {
      yield COMPACTION_START;
      // A tool the CLI runs itself, started while the compaction is still open.
      yield {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-during-compaction",
              name: "Bash",
              input: { command: "true" },
            },
          ],
        },
      };
      started.resolve(Date.now());
      await finish.promise;
      yield { type: "result", subtype: "success", result: "tool during compaction" };
    },
  };
  const owner = createDiagnosticEmbeddedRunOwner(context.params);
  context.params.diagnosticOwner = owner;
  logSessionStateChange({ ...context.params, state: "processing" });
  markDiagnosticEmbeddedRunStarted({ ...context.params, owner });

  const run = wrapPreparedCliRunWithTestAdmission(executePreparedCliRun)(context);
  try {
    const startedAt = await started.promise;
    await vi.advanceTimersByTimeAsync(0);
    await waitForDiagnosticEventsDrained();

    // The plugin runner leaves parsed tools out of its outstanding-work report, so the
    // compaction's own allowance is still what it reports here. That is not a gap: the
    // tool's own tool.execution.started event makes this a tool_call for diagnostics,
    // and the tool branch of the stale threshold never reads the backend deadline.
    const snapshot = getDiagnosticSessionActivitySnapshot(context.params);
    expect(snapshot).toMatchObject({
      activeWorkKind: "tool_call",
      activeBackendLivenessDeadlineAtMs: startedAt + BLOCKED_TOOL_CALL_ABORT_FLOOR_MS,
    });
    expect(
      resolveRunStaleThresholdMs(snapshot, snapshot.lastProgressAgeMs ?? 0, STUCK_SESSION_ABORT_MS),
    ).toBe(BLOCKED_TOOL_CALL_ABORT_FLOOR_MS);

    finish.resolve();
    await expect(run).resolves.toMatchObject({ text: "tool during compaction" });
  } finally {
    finish.resolve();
    await Promise.allSettled([run]);
    closeDiagnosticEmbeddedRunOwner(owner);
  }
});
