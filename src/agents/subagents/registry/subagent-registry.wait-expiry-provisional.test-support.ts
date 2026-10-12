/**
 * Wait-expiry publication cases for the registry seam suite: an expired wait
 * publishes expiry without terminalizing the run, and an unconfirmed child
 * keeps every terminal tail, durable signal and plugin hook withheld until an
 * observed stop promotes it.
 *
 * Extracted from subagent-registry.test.ts so that file stays under its line
 * cap; the owning suite hands in its mock state and harness accessors.
 */
import { expect, it, vi } from "vitest";
import {
  createSessionEntry,
  createSessionStore,
  mockCallArg as getMockCallArg,
  waitForFast,
} from "../../subagent-test-fixtures.test-helpers.js";
import { resolveSubagentKillTargetState } from "./subagent-registry-completion.js";
import type { SubagentRegistrySeamFixture } from "./subagent-registry.seam-fixture.test-support.js";
import { resolveSubagentSessionStatus } from "./subagent-session-metrics.js";

export function registerWaitExpiryProvisionalTests(fixture: SubagentRegistrySeamFixture) {
  const { findRequesterRun, getRegistry, mocks, observerTerminalSignals } = fixture;
  const registry = () => getRegistry();

  it("publishes expiry at explicit runTimeoutSeconds without terminalizing a bare wait", async () => {
    const startedAt = Date.now();
    let waitAttempts = 0;
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        waitAttempts += 1;
        return { status: "timeout" };
      }
      return {};
    });
    mocks.entries = {
      "agent:main:subagent:child": createSessionEntry({
        updatedAt: startedAt,
      }),
    };

    await registry().registerSubagentRun({
      runId: "run-explicit-timeout",
      task: "respect explicit timeout",
      runTimeoutSeconds: 1,
    });

    await waitForFast(() => {
      expect(waitAttempts).toBeGreaterThanOrEqual(1);
    });
    const activeRun = findRequesterRun("run-explicit-timeout");
    expect(activeRun?.execution.endedAt).toBeUndefined();
    expect(activeRun?.execution.outcome).toBeUndefined();

    await vi.advanceTimersByTimeAsync(5_000);

    await waitForFast(() => {
      const completedRun = findRequesterRun("run-explicit-timeout");
      expect(waitAttempts).toBeGreaterThanOrEqual(2);
      expect(completedRun?.execution.endedAt).toBeUndefined();
      expect(completedRun?.execution.outcome).toBeUndefined();
      expect(completedRun?.waitExpiryObservedAt).toBe(startedAt + 1_000);
    });
    await waitForFast(() => {
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps a delete-cleanup child session alive when only the wait deadline expired", async () => {
    const startedAt = Date.now();
    let waitAttempts = 0;
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        waitAttempts += 1;
        return { status: "timeout" };
      }
      return {};
    });
    mocks.entries = createSessionStore({
      updatedAt: startedAt,
      sessionId: "sess-unconfirmed",
      lifecycleRevision: "rev-unconfirmed",
    });

    await registry().registerSubagentRun({
      runId: "run-unconfirmed-delete-cleanup",
      task: "unconfirmed child keeps its session",
      cleanup: "delete",
      runTimeoutSeconds: 1,
    });

    await waitForFast(() => {
      expect(waitAttempts).toBeGreaterThanOrEqual(1);
    });
    await vi.advanceTimersByTimeAsync(5_000);

    await waitForFast(() => {
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    });
    // Regression (openclaw-kkv1 round 1): completing on the stored deadline
    // observed nothing, so the child may still be running. Handing the announce
    // cleanup: "delete" would submit sessions.delete with deleteTranscript for a
    // live session — the announce itself says the child may still be working.
    const announceParams = getMockCallArg(
      mocks.runSubagentAnnounceFlow,
      0,
      0,
      "unconfirmed announce params",
    );
    expect(announceParams.cleanup).toBe("keep");
    expect(announceParams.onBeforeDeleteChildSession).toBeUndefined();
    const deleteCalls = () =>
      mocks.callGateway.mock.calls.filter(([request]) => request.method === "sessions.delete");
    expect(deleteCalls()).toHaveLength(0);
    // Deferred, not cancelled. The row keeps cleanup: "delete" so the real mode
    // is restored the moment a stop is observed.
    const completedRun = findRequesterRun("run-unconfirmed-delete-cleanup");
    expect(completedRun?.cleanup).toBe("delete");
    expect(completedRun?.waitExpiryObservedAt).toEqual(expect.any(Number));
    // Regression (openclaw-odqn round 2, finding 2): this config sets
    // archiveAfterMinutes: 0, the documented no-auto-archive opt-out. Round 1
    // overrode it with a 60-minute floor so the deferred deletion would have an
    // owner; that turned a documented opt-out into a blind deletion timer. The
    // owner is observed stop evidence, never a clock, so zero stays zero.
    expect(completedRun?.archiveAtMs).toBeUndefined();
    // The child's own session entry must not have been stamped terminal by our
    // guess either — it is the only independent record of the child's liveness.
    expect(mocks.applySessionEntryExactReplacements).not.toHaveBeenCalled();

    expect(mocks.getAgentRunContext("run-unconfirmed-delete-cleanup")).toBeUndefined();
    // Long past any retention window, with the child session still reporting
    // running: no clock may delete it, and the row must survive so a later
    // observed stop can still settle it.
    vi.setSystemTime(startedAt + 1_000 + 61 * 60_000);
    await registry().testing.sweepOnceForTests();
    expect(deleteCalls()).toHaveLength(0);
    expect(findRequesterRun("run-unconfirmed-delete-cleanup")?.execution).toMatchObject({
      status: "running",
    });
    expect(findRequesterRun("run-unconfirmed-delete-cleanup")?.execution.endedAt).toBeUndefined();
    expect(mocks.cleanupBrowserSessionsForLifecycleEnd).not.toHaveBeenCalled();

    // The child finally records its own stop. That is authoritative evidence,
    // so the sweeper promotes the row and the deferred cleanup completes.
    mocks.entries = createSessionStore({
      updatedAt: startedAt + 1_000 + 62 * 60_000,
      endedAt: startedAt + 1_000 + 62 * 60_000,
      status: "done",
      sessionId: "sess-unconfirmed",
      lifecycleRevision: "rev-unconfirmed",
    });
    vi.setSystemTime(startedAt + 1_000 + 63 * 60_000);
    await registry().testing.sweepOnceForTests();
    // Promotion re-opens the cleanup that was withheld, so the delete-mode row
    // settles and retires, and the terminal tails that never ran for the
    // unconfirmed row finally run against the observed stop.
    await waitForFast(() => {
      expect(findRequesterRun("run-unconfirmed-delete-cleanup")).toBeUndefined();
      expect(mocks.onSubagentEnded).toHaveBeenCalled();
    });
    // The child's session entry gets its real terminal timing only now, from an
    // observed stop rather than from our own deadline guess.
    expect(mocks.applySessionEntryExactReplacements).toHaveBeenCalled();
    // The actual completion must follow the provisional wake.
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(2);
  });

  it("routes a private child's provisional wait-expiry wake by its completion target", async () => {
    const startedAt = Date.now();
    let waitAttempts = 0;
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        waitAttempts += 1;
        return { status: "timeout" };
      }
      return {};
    });
    mocks.entries = createSessionStore({
      updatedAt: startedAt,
    });

    await registry().registerSubagentRun({
      runId: "run-unconfirmed-private-child",
      task: "private child keeps its provisional wake parent-only",
      expectsCompletionMessage: true,
      completionTarget: "parent",
      completionRequesterSessionId: "sess-private-parent",
      runTimeoutSeconds: 1,
    });

    await waitForFast(() => {
      expect(waitAttempts).toBeGreaterThanOrEqual(1);
    });
    await vi.advanceTimersByTimeAsync(5_000);

    await waitForFast(() => {
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    });
    // A parent-only child must have completion notifications on, so the
    // producer's collect/expectsCompletionMessage skip cannot exclude it. The
    // terminal producers forward the private-completion fields; the provisional
    // wake has to as well or the still-running notice takes the public route.
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryPhase: "wait-expiry",
        outcome: { status: "timeout", disposition: "still-running" },
        completionTarget: "parent",
        completionRequesterSessionId: "sess-private-parent",
      }),
    );
  });

  it("runs no terminal cleanup tails for an unconfirmed child until an observed stop promotes it", async () => {
    // Regression (openclaw-odqn round 2, finding 1): round 1 only withheld
    // sessions.delete. Cleanup bookkeeping still tore down internal session
    // effects, retired the child's MCP runtime, stamped a terminal status onto
    // the child's session entry, and reported the child completed to the
    // context engine — all against a child the announce says may still be live.
    const startedAt = Date.now();
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        return { status: "timeout" };
      }
      return {};
    });
    mocks.entries = createSessionStore({
      updatedAt: startedAt,
      sessionId: "sess-no-tails",
      lifecycleRevision: "rev-no-tails",
    });

    await registry().registerSubagentRun({
      runId: "run-unconfirmed-no-tails",
      task: "unconfirmed child runs no terminal tails",
      cleanup: "keep",
      runTimeoutSeconds: 1,
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await waitForFast(() => {
      expect(findRequesterRun("run-unconfirmed-no-tails")?.waitExpiryObservedAt).toEqual(
        expect.any(Number),
      );
    });
    // The parent still gets woken — that is the point of completing the row.
    await waitForFast(() => {
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    });
    // …but nothing the child owns may be torn down yet.
    expect(mocks.removeInternalSessionEffectsSession).not.toHaveBeenCalled();
    expect(mocks.onSubagentEnded).not.toHaveBeenCalled();
    expect(mocks.applySessionEntryExactReplacements).not.toHaveBeenCalled();

    // An observed stop promotes the row, and only then do the tails run.
    mocks.entries = createSessionStore({
      updatedAt: startedAt + 30_000,
      endedAt: startedAt + 30_000,
      status: "done",
      sessionId: "sess-no-tails",
      lifecycleRevision: "rev-no-tails",
    });
    vi.setSystemTime(startedAt + 40_000);
    await registry().testing.sweepOnceForTests();

    await waitForFast(() => {
      expect(mocks.onSubagentEnded).toHaveBeenCalled();
    });
    expect(mocks.removeInternalSessionEffectsSession).toHaveBeenCalled();
  });

  it("publishes no durable terminal signal for an unconfirmed child until an observed stop promotes it", async () => {
    // Regression (openclaw-odqn round 3): the terminal-signal projection sits
    // BEFORE the deferred-cleanup guard round 2 added, so an unconfirmed expiry
    // still recorded a durable `run_failed` / "child run timed out" event. The
    // signal log inserts on a `run-terminal:<runId>` dedupe key with
    // conflict-do-nothing, so that first write is permanent: authoritative
    // promotion afterwards cannot replace it, and an observer keeps being told a
    // possibly-live child died. This reads back through
    // listSessionStateEventsSince — the single source sessions.status uses to
    // build its `stateChanges` block — so it asserts the observer surface, not
    // just the producer call.
    const startedAt = Date.now();
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        return { status: "timeout" };
      }
      return {};
    });
    mocks.entries = createSessionStore({
      updatedAt: startedAt,
      sessionId: "sess-terminal-signal",
      lifecycleRevision: "rev-terminal-signal",
    });

    await registry().registerSubagentRun({
      runId: "run-unconfirmed-terminal-signal",
      task: "unconfirmed child publishes no terminal signal",
      cleanup: "keep",
      runTimeoutSeconds: 1,
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await waitForFast(() => {
      expect(findRequesterRun("run-unconfirmed-terminal-signal")?.waitExpiryObservedAt).toEqual(
        expect.any(Number),
      );
    });
    // The parent is still woken; only the durable death claim is withheld.
    await waitForFast(() => {
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    });
    expect(await observerTerminalSignals("run-unconfirmed-terminal-signal")).toEqual([]);

    // The child records its own stop. That is authoritative evidence, so
    // promotion re-drives the withheld terminal effects — including this
    // projection, whose claim is now earned rather than guessed.
    mocks.entries = createSessionStore({
      updatedAt: startedAt + 30_000,
      endedAt: startedAt + 30_000,
      status: "done",
      sessionId: "sess-terminal-signal",
      lifecycleRevision: "rev-terminal-signal",
    });
    vi.setSystemTime(startedAt + 40_000);
    await registry().testing.sweepOnceForTests();

    // This half is also the anti-vacuity control: it proves the signal log is
    // live and readable in this harness, so the empty assertion above is a real
    // absence rather than an unreachable database.
    await waitForFast(async () => {
      expect(await observerTerminalSignals("run-unconfirmed-terminal-signal")).toEqual([
        { kind: "run_completed", summary: "child run completed", outcome: undefined },
      ]);
    });
  });

  it("emits no terminal plugin hooks for an unconfirmed child and exactly one of each after promotion", async () => {
    // Regression (openclaw-odqn round 4): the deferral covered the durable
    // signal-log record and the session writes, but the two plugin-visible
    // terminal projections still ran for a `child-unconfirmed` row. Both are
    // unrepeatable, so a premature emit is not merely early — it is final:
    // `subagent_ended` persists `endedHookEmittedAt` (exactly-once), and
    // `progress ended` latches once per entry (progressEndedEntries). Channel plugins
    // also act on `subagent_ended` destructively (Discord unbinds the child's
    // thread bindings, Feishu its session binding), so the false emit tears
    // down routing for a child that may still be live. These assertions run
    // against the real hook-runner boundary the plugins subscribe to.
    const startedAt = Date.now();
    const runSubagentProgress = vi.fn<(event: { phase?: string; runId?: string }) => Promise<void>>(
      async () => {},
    );
    mocks.getGlobalHookRunner.mockReturnValue({
      hasHooks: (hookName: string) =>
        hookName === "subagent_ended" || hookName === "subagent_progress",
      runSubagentEnded: mocks.runSubagentEnded,
      runSubagentProgress,
    } as never);
    const endedProgressPhases = () =>
      runSubagentProgress.mock.calls.filter(
        ([event]) => event.phase === "ended" && event.runId === "run-unconfirmed-terminal-hooks",
      );
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        return { status: "timeout" };
      }
      return {};
    });
    mocks.entries = createSessionStore({
      updatedAt: startedAt,
      sessionId: "sess-terminal-hooks",
      lifecycleRevision: "rev-terminal-hooks",
    });

    await registry().registerSubagentRun({
      runId: "run-unconfirmed-terminal-hooks",
      task: "unconfirmed child emits no terminal plugin hooks",
      cleanup: "keep",
      runTimeoutSeconds: 1,
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await waitForFast(() => {
      expect(findRequesterRun("run-unconfirmed-terminal-hooks")?.waitExpiryObservedAt).toEqual(
        expect.any(Number),
      );
    });
    // The parent is still woken — the announce is the notification that the
    // wait ended, and it is deliberately NOT deferred.
    await waitForFast(() => {
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    });
    expect(mocks.runSubagentEnded).not.toHaveBeenCalled();
    expect(endedProgressPhases()).toEqual([]);
    expect(findRequesterRun("run-unconfirmed-terminal-hooks")?.endedHookEmittedAt).toBeUndefined();

    // The child records its own stop. That is authoritative evidence, so
    // promotion reopens cleanup and the withheld hooks finally fire — each
    // exactly once, because neither unrepeatable marker was consumed early.
    mocks.entries = createSessionStore({
      updatedAt: startedAt + 30_000,
      endedAt: startedAt + 30_000,
      status: "done",
      sessionId: "sess-terminal-hooks",
      lifecycleRevision: "rev-terminal-hooks",
    });
    vi.setSystemTime(startedAt + 40_000);
    await registry().testing.sweepOnceForTests();

    // This half is also the anti-vacuity control: it proves both hooks are
    // genuinely reachable in this harness, so the absences above are real.
    await waitForFast(() => {
      expect(mocks.runSubagentEnded).toHaveBeenCalledTimes(1);
      expect(endedProgressPhases()).toHaveLength(1);
    });
    const endedHookEvents = mocks.runSubagentEnded.mock.calls as unknown as ReadonlyArray<
      readonly [{ targetSessionKey?: string; outcome?: string }]
    >;
    expect(endedHookEvents[0]?.[0]?.targetSessionKey).toBe("agent:main:subagent:child");
    expect(typeof findRequesterRun("run-unconfirmed-terminal-hooks")?.endedHookEmittedAt).toBe(
      "number",
    );
  });

  it("keeps an unconfirmed child nonterminal in the registry and promotes it to succeeded", async () => {
    // Regression (openclaw-odqn round 5, finding 1): a deadline-only wait expiry
    // must not project a terminal status for the child. A terminal `timeout`
    // would make the child's later observed success unrepresentable and leave a
    // still-running child permanently reported as dead. Asserted through the
    // registry's own read projections (session status and the finalized
    // terminal-state boundary), not through a spy on a write.
    const startedAt = Date.now();
    const runId = "run-unconfirmed-terminal-state";
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        return { status: "timeout" };
      }
      return {};
    });
    mocks.entries = createSessionStore({
      updatedAt: startedAt,
      sessionId: "sess-terminal-state",
      lifecycleRevision: "rev-terminal-state",
    });

    await registry().registerSubagentRun({
      runId,
      task: "unconfirmed child keeps a nonterminal state",
      cleanup: "keep",
      runTimeoutSeconds: 1,
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await waitForFast(() => {
      expect(findRequesterRun(runId)?.waitExpiryObservedAt).toEqual(expect.any(Number));
    });
    // The parent is still woken; the announce is deliberately not deferred.
    await waitForFast(() => {
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    });

    // What a parent reads must not claim the child died. `running` is the
    // truthful answer: the wait ended, the child did not.
    const provisional = findRequesterRun(runId);
    expect(provisional?.execution.endedAt).toBeUndefined();
    expect(provisional?.execution.outcome).toBeUndefined();
    expect(resolveSubagentSessionStatus(provisional)).toBe("running");
    expect(provisional && resolveSubagentKillTargetState(provisional)).toBeUndefined();

    // The child's own record turns out to say it finished *successfully*,
    // 100ms before the deadline the wait expired on. The deadline was a clock
    // comparison, so the wait simply never saw the stop. Publishing a terminal
    // timeout above would have made this success unrepresentable forever. (A
    // stop observed *after* the deadline still promotes to `timeout` —
    // truthfully; that path is covered by the late-lifecycle-timeout case.)
    mocks.entries = createSessionStore({
      updatedAt: startedAt + 900,
      endedAt: startedAt + 900,
      status: "done",
      sessionId: "sess-terminal-state",
      lifecycleRevision: "rev-terminal-state",
    });
    vi.setSystemTime(startedAt + 40_000);
    await registry().testing.sweepOnceForTests();

    // Anti-vacuity control: the promotion must actually land as a success. It
    // can only do so because nothing published a terminal timeout first.
    await waitForFast(() => {
      const promoted = findRequesterRun(runId);
      expect(promoted?.execution.outcome?.status).toBe("ok");
      expect(resolveSubagentSessionStatus(promoted)).toBe("done");
    });
  });

  it("retains an unconfirmed child whose session snapshot is absent and retires it on an observed stop", async () => {
    // Regression (openclaw-odqn round 5, finding 2): the sweeper deferred only
    // while the child's session entry said `running`. An `absent` entry fell
    // through to TTL deletion plus attachment removal — but the entry is
    // best-effort and reads absent when the store is unreadable, not yet
    // written, or simply missing, so absence is not evidence of a stop. Fail
    // closed: retain and retry until something observed the child stop.
    const startedAt = Date.now();
    const runId = "run-unconfirmed-absent-session";
    const deleteCalls = () =>
      mocks.callGateway.mock.calls.filter(([request]) => request.method === "sessions.delete");
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        return { status: "timeout" };
      }
      return {};
    });
    mocks.entries = createSessionStore({
      updatedAt: startedAt,
      sessionId: "sess-absent",
      lifecycleRevision: "rev-absent",
    });

    await registry().registerSubagentRun({
      runId,
      task: "unconfirmed child with a vanishing session entry",
      // delete-mode is what makes the row reach retention teardown at all; a
      // keep-mode row would be retained for unrelated reasons.
      cleanup: "delete",
      runTimeoutSeconds: 1,
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await waitForFast(() => {
      expect(findRequesterRun(runId)?.waitExpiryObservedAt).toEqual(expect.any(Number));
    });

    // The child's session entry is now unreadable. Nothing has been observed to
    // stop it, so no clock past SESSION_RUN_TTL_MS may retire it.
    mocks.entries = {};
    vi.setSystemTime(startedAt + 61 * 60_000);
    await registry().testing.sweepOnceForTests();
    expect(findRequesterRun(runId)).toBeDefined();
    expect(deleteCalls()).toHaveLength(0);

    // Still absent much later: retain and retry, never a bounded give-up. A
    // clock-based escape here would reintroduce exactly the bug this PR fixes.
    vi.setSystemTime(startedAt + 180 * 60_000);
    await registry().testing.sweepOnceForTests();
    expect(findRequesterRun(runId)).toBeDefined();
    expect(deleteCalls()).toHaveLength(0);

    // Anti-vacuity control: the entry reappears with the child's own terminal
    // record. That is stop evidence, so the row promotes and finally retires —
    // proving retention is gated on evidence, not disabled.
    mocks.entries = createSessionStore({
      updatedAt: startedAt + 181 * 60_000,
      endedAt: startedAt + 181 * 60_000,
      status: "done",
      sessionId: "sess-absent",
      lifecycleRevision: "rev-absent",
    });
    vi.setSystemTime(startedAt + 182 * 60_000);
    await registry().testing.sweepOnceForTests();
    await waitForFast(() => {
      expect(findRequesterRun(runId)).toBeUndefined();
    });
  });
}
