import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { BLOCKED_TOOL_CALL_ABORT_FLOOR_MS } from "../../logging/diagnostic-run-activity.js";
import type { RunExit } from "../../process/supervisor/types.js";
import { CLI_RESUME_WATCHDOG_DEFAULTS } from "../cli-watchdog-defaults.js";
import {
  closePluginTestAdmissions,
  createExecution,
  runPlugin,
  SUCCESS_RESULT,
  waitUntilAborted,
} from "./execute-plugin.test-support.js";

// The silence measured in the linked report, #138644, and the only near-limit
// compaction timing on record: its last stream event at 21:34:30.941Z and its
// compaction output at 21:37:31.385Z are 180_444ms apart, and its audit row closes
// that run at 180.4s. The live capture on this branch measured 14_360ms, but on a
// 27.5k-token session, and auto-compaction fires near the context limit. So this,
// not the live number, is the silence the ceiling has to clear.
const REPORTED_COMPACTION_SILENCE_MS = 180_444;

afterEach(() => {
  closePluginTestAdmissions();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("plugin-owned CLI execution native compaction watchdog", () => {
  it("keeps native compaction alive beyond the ordinary no-output watchdog", async () => {
    vi.useFakeTimers();
    const { context } = await createExecution();
    const compactionFinished = createDeferred();
    const received: string[] = [];
    let compacting = false;
    let completed = false;
    const run = runPlugin(
      context,
      async function* () {
        compacting = true;
        yield { type: "system", subtype: "status", status: "compacting" };
        await compactionFinished.promise;
        compacting = false;
        yield { compact_result: "success" };
        yield SUCCESS_RESULT;
      },
      {
        noOutputTimeoutMs: 100,
        consumeStdout: received.push.bind(received),
        compactionActive: () => compacting,
      },
    ).then((result) => {
      completed = true;
      return result;
    });
    await vi.waitFor(() => expect(received).toHaveLength(1));

    await vi.advanceTimersByTimeAsync(150);
    expect(completed).toBe(false);

    compactionFinished.resolve();
    await expect(run).resolves.toMatchObject({ reason: "exit", timedOut: false });
    expect(received.map((event) => JSON.parse(event))).toHaveLength(3);
  });

  it("terminates through the no-output watchdog once compaction has ended", async () => {
    vi.useFakeTimers();
    const { context } = await createExecution({ timeoutMs: 5_000 });
    const received: string[] = [];
    let compacting = false;
    const run = runPlugin(
      context,
      async function* (execution) {
        compacting = true;
        yield { type: "system", subtype: "status", status: "compacting" };
        // Compaction ends, but the turn then goes silent again with nothing
        // else outstanding; a finished compaction must not grant permanent
        // immunity from the ordinary no-output watchdog.
        compacting = false;
        yield { compact_result: "success" };
        await waitUntilAborted(execution);
        yield SUCCESS_RESULT;
      },
      {
        noOutputTimeoutMs: 100,
        consumeStdout: received.push.bind(received),
        compactionActive: () => compacting,
      },
    );
    await vi.waitFor(() => expect(received).toHaveLength(2));

    await vi.advanceTimersByTimeAsync(100);

    await expect(run).resolves.toMatchObject({
      reason: "no-output-timeout",
      exitCode: null,
      timedOut: true,
      noOutputTimedOut: true,
    });
  });

  it("terminates a compaction that starts and never ends at the outstanding-work floor", async () => {
    vi.useFakeTimers();
    // No overall deadline in play: the no-output watchdog is the only thing that can
    // end this run, which is exactly the stalled-compaction case under review.
    const { context } = await createExecution({ timeoutMs: 60 * 60_000 });
    const received: string[] = [];
    // Settled is read synchronously so a mutation that removes the ceiling fails the
    // assertion immediately instead of hanging this suite until its timeout.
    let settled: RunExit | undefined;
    const run = runPlugin(
      context,
      async function* (execution) {
        // A start record with no matching end record, then permanent silence.
        yield { type: "system", subtype: "status", status: "compacting" };
        await waitUntilAborted(execution);
        yield SUCCESS_RESULT;
      },
      {
        noOutputTimeoutMs: 180_000,
        consumeStdout: received.push.bind(received),
        compactionActive: () => true,
      },
    ).then((result) => (settled = result));
    await vi.waitFor(() => expect(received).toHaveLength(1));

    // One tick short of the floor the run is still deferred, so the bound is the
    // outstanding-work floor and not some earlier coincidence.
    await vi.advanceTimersByTimeAsync(BLOCKED_TOOL_CALL_ABORT_FLOOR_MS - 2_000);
    expect(settled).toBeUndefined();

    // Crossing it terminates. A wedged compaction is detected at the same point a
    // wedged tool call is, which is the accepted cost of not tuning a second value.
    await vi.advanceTimersByTimeAsync(4_000);
    expect(settled).toMatchObject({
      reason: "no-output-timeout",
      timedOut: true,
      noOutputTimedOut: true,
    });
    await run;
  });

  it("survives the near-limit compaction silence measured in the linked report", async () => {
    vi.useFakeTimers();
    const { context } = await createExecution({ timeoutMs: 60 * 60_000 });
    const received: string[] = [];
    const compactionFinished = createDeferred();
    let compacting = false;
    let settled: RunExit | undefined;
    const run = runPlugin(
      context,
      async function* () {
        compacting = true;
        yield { type: "system", subtype: "status", status: "compacting" };
        await compactionFinished.promise;
        compacting = false;
        yield { compact_result: "success" };
        yield SUCCESS_RESULT;
      },
      {
        // The budget production derives for a resumed run, not a compressed one.
        noOutputTimeoutMs: CLI_RESUME_WATCHDOG_DEFAULTS.maxMs,
        consumeStdout: received.push.bind(received),
        compactionActive: () => compacting,
      },
    ).then((result) => (settled = result));
    await vi.waitFor(() => expect(received).toHaveLength(1));

    // The reported run was terminated at exactly this point, with 894 transcript
    // lines of completed work behind it. This one is still deferred.
    await vi.advanceTimersByTimeAsync(REPORTED_COMPACTION_SILENCE_MS);
    expect(settled).toBeUndefined();

    compactionFinished.resolve();
    await expect(run).resolves.toMatchObject({ reason: "exit", timedOut: false });

    // Measured, and the whole reason this case exists: the reported silence sits above
    // the budget that killed the run and below the floor compaction now inherits. Both
    // bounds are shipped constants, so neither is a number anyone had to choose here.
    expect(REPORTED_COMPACTION_SILENCE_MS).toBeGreaterThan(CLI_RESUME_WATCHDOG_DEFAULTS.maxMs);
    expect(REPORTED_COMPACTION_SILENCE_MS).toBeLessThan(BLOCKED_TOOL_CALL_ABORT_FLOOR_MS);
  });

  it("reproduces the reported termination when the watchdog cannot see the compaction", async () => {
    vi.useFakeTimers();
    const { context } = await createExecution({ timeoutMs: 60 * 60_000 });
    const received: string[] = [];
    let settled: RunExit | undefined;
    const run = runPlugin(
      context,
      async function* (execution) {
        // The same timeline as the case above, minus the only thing this PR adds:
        // the compaction is invisible to the predicate, which is main's behaviour.
        yield { type: "system", subtype: "status", status: "compacting" };
        await waitUntilAborted(execution);
        yield SUCCESS_RESULT;
      },
      {
        noOutputTimeoutMs: CLI_RESUME_WATCHDOG_DEFAULTS.maxMs,
        consumeStdout: received.push.bind(received),
        compactionActive: () => false,
      },
    ).then((result) => (settled = result));
    await vi.waitFor(() => expect(received).toHaveLength(1));

    // One tick short of the ordinary budget the turn is still alive. Asserting this
    // first is what makes the case able to fail: without it the run could have been
    // killed at the first tick and the termination assertion below would still pass.
    await vi.advanceTimersByTimeAsync(CLI_RESUME_WATCHDOG_DEFAULTS.maxMs - 2_000);
    expect(settled).toBeUndefined();

    // Crossing the budget kills it, so the bound here is the ordinary budget exactly.
    await vi.advanceTimersByTimeAsync(4_000);
    expect(settled).toMatchObject({
      reason: "no-output-timeout",
      timedOut: true,
      noOutputTimedOut: true,
    });

    // And that kill lands before the reported compaction output would have arrived,
    // which is the lost turn in #138644: 894 transcript lines of completed work
    // discarded while the CLI was healthy.
    expect(CLI_RESUME_WATCHDOG_DEFAULTS.maxMs).toBeLessThan(REPORTED_COMPACTION_SILENCE_MS);
    await run;
  });

  it("keeps the blocked-tool floor for a compaction that overlaps real tool work", async () => {
    vi.useFakeTimers();
    const { context } = await createExecution({ timeoutMs: 60 * 60_000 });
    const received: string[] = [];
    let settled: RunExit | undefined;
    const run = runPlugin(
      context,
      async function* (execution) {
        yield { type: "system", subtype: "status", status: "compacting" };
        await waitUntilAborted(execution);
        yield SUCCESS_RESULT;
      },
      {
        noOutputTimeoutMs: 180_000,
        consumeStdout: received.push.bind(received),
        compactionActive: () => true,
        // A tool call outstanding alongside compaction keeps the wider floor it
        // already had before compaction was ever a deferral term.
        activeToolCount: () => 1,
      },
    ).then((result) => (settled = result));
    await vi.waitFor(() => expect(received).toHaveLength(1));

    // One tick short of the blocked-tool floor the run is still deferred, so the
    // bound is that floor exactly and compaction on the same tick did not shorten it.
    await vi.advanceTimersByTimeAsync(BLOCKED_TOOL_CALL_ABORT_FLOOR_MS - 2_000);
    expect(settled).toBeUndefined();

    await vi.advanceTimersByTimeAsync(4_000);
    expect(settled).toMatchObject({
      reason: "no-output-timeout",
      timedOut: true,
      noOutputTimedOut: true,
    });
    await run;
  });

  it("measures the compaction grace from the last stdout record, not compaction start", async () => {
    vi.useFakeTimers();
    const { context } = await createExecution({ timeoutMs: 60 * 60_000 });
    const received: string[] = [];
    const midCompactionRecord = createDeferred();
    let settled: RunExit | undefined;
    const run = runPlugin(
      context,
      async function* (execution) {
        yield { type: "system", subtype: "status", status: "compacting" };
        // Claude Code is silent while it compacts, but the watchdog does not assume
        // so: any stdout record restarts the quiet clock, exactly as it does for a
        // tool call, and the grace bounds the silence since that record.
        await midCompactionRecord.promise;
        yield { type: "stream_event", event: { type: "ping" } };
        await waitUntilAborted(execution);
        yield SUCCESS_RESULT;
      },
      {
        noOutputTimeoutMs: 180_000,
        consumeStdout: received.push.bind(received),
        compactionActive: () => true,
      },
    ).then((result) => (settled = result));
    await vi.waitFor(() => expect(received).toHaveLength(1));

    await vi.advanceTimersByTimeAsync(BLOCKED_TOOL_CALL_ABORT_FLOOR_MS - 60_000);
    midCompactionRecord.resolve();
    await vi.waitFor(() => expect(received).toHaveLength(2));

    // The grace measured from compaction start has passed and the run is still
    // deferred, so that is not the clock in play.
    await vi.advanceTimersByTimeAsync(60_000 + 2_000);
    expect(settled).toBeUndefined();

    // One tick short of a full grace after the mid-compaction record: still deferred.
    await vi.advanceTimersByTimeAsync(BLOCKED_TOOL_CALL_ABORT_FLOOR_MS - 62_000 - 2_000);
    expect(settled).toBeUndefined();

    await vi.advanceTimersByTimeAsync(4_000);
    expect(settled).toMatchObject({
      reason: "no-output-timeout",
      timedOut: true,
      noOutputTimedOut: true,
    });
    await run;
  });

  it("keeps the overall deadline authoritative while compaction remains active", async () => {
    vi.useFakeTimers();
    const { context } = await createExecution({ timeoutMs: 150 });
    const received: string[] = [];
    const run = runPlugin(
      context,
      async function* (execution) {
        yield { type: "system", subtype: "status", status: "compacting" };
        await waitUntilAborted(execution);
        yield SUCCESS_RESULT;
      },
      {
        noOutputTimeoutMs: 100,
        consumeStdout: received.push.bind(received),
        compactionActive: () => true,
      },
    );
    await vi.waitFor(() => expect(received).toHaveLength(1));

    await vi.advanceTimersByTimeAsync(150);

    await expect(run).resolves.toMatchObject({
      reason: "overall-timeout",
      timedOut: true,
      noOutputTimedOut: false,
    });
  });
});

describe("compaction reported as outstanding work", () => {
  it("notifies onOutstandingWorkChange when compaction becomes active and inactive", async () => {
    vi.useFakeTimers();
    const { context } = await createExecution();
    const workChanged: boolean[] = [];
    let compacting = false;
    // simulate what execute-process.ts wires from events.hasActiveCompaction
    const compactionChangeListeners = new Set<() => void>();
    const onCompactionActiveChange = (listener: () => void) => {
      compactionChangeListeners.add(listener);
      return () => compactionChangeListeners.delete(listener);
    };

    const run = runPlugin(
      context,
      async function* () {
        compacting = true;
        for (const l of compactionChangeListeners) {
          l();
        }
        yield { type: "system", subtype: "status", status: "compacting" };
        compacting = false;
        for (const l of compactionChangeListeners) {
          l();
        }
        yield { compact_result: "success" };
        yield { type: "result", subtype: "success", is_error: false, result: "ok" };
      },
      {
        noOutputTimeoutMs: 10_000,
        compactionActive: () => compacting,
        onCompactionActiveChange,
        onOutstandingWorkChange: (active) => {
          workChanged.push(active);
        },
      },
    );
    await expect(run).resolves.toMatchObject({ reason: "exit", timedOut: false });
    // Exact sequence, not membership: `toContain` also accepts a report that
    // latches on and never withdraws. The trailing false is the terminal report
    // `executePluginOwnedProcess` makes when it closes the turn.
    expect(workChanged).toEqual([true, false, false]);
  });

  it("reports every work mix through the one-argument call shape untouched callers assert", async () => {
    vi.useFakeTimers();
    const { context } = await createExecution();
    const onOutstandingWorkChange = vi.fn();
    let compacting = false;
    const compactionChangeListeners = new Set<() => void>();
    const onCompactionActiveChange = (listener: () => void) => {
      compactionChangeListeners.add(listener);
      return () => compactionChangeListeners.delete(listener);
    };
    const setCompacting = (next: boolean) => {
      compacting = next;
      for (const listener of compactionChangeListeners) {
        listener();
      }
    };

    const run = runPlugin(
      context,
      async function* () {
        setCompacting(true);
        yield { type: "system", subtype: "status", status: "compacting" };
        // Background work appears alongside the compaction, then drains again, so the
        // report is exercised with compaction alone and with compaction plus other work.
        yield { type: "system", subtype: "background_tasks_changed", tasks: [{ id: "t1" }] };
        yield { type: "system", subtype: "background_tasks_changed", tasks: [] };
        setCompacting(false);
        yield { compact_result: "success" };
        yield { type: "result", subtype: "success", is_error: false, result: "ok" };
      },
      {
        noOutputTimeoutMs: 10_000,
        compactionActive: () => compacting,
        onCompactionActiveChange,
        onOutstandingWorkChange,
      },
    );
    await expect(run).resolves.toMatchObject({ reason: "exit", timedOut: false });

    // Compaction is reported as plain outstanding work and carries no extra argument,
    // so a caller that asserts the exact call shape sees what it saw before this
    // change. A second argument added back here fails on arity, not on value.
    expect(onOutstandingWorkChange.mock.calls).toEqual([[true], [true], [true], [false], [false]]);
  });
});
