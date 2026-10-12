/**
 * Unconfirmed-child promotion cases for the registry seam suite: silent-cleanup
 * deletion, timeout observation, delivery-payload correction after a late
 * lifecycle abort, and provisional announcement retry.
 *
 * Extracted from subagent-registry.test.ts so that file stays under its line
 * cap; the owning suite hands in its mock state and harness accessors.
 */
import { expect, it, vi } from "vitest";
import {
  createSessionEntry,
  createSessionStore,
  createSubagentRunRecord,
  expectRecordFields,
  mockGatewayMethods,
  waitForFast,
} from "../../subagent-test-fixtures.test-helpers.js";
import { updateSubagentRunFixture as updateFixtureRun } from "./subagent-registry-result-refresh.test-support.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import { registerRestoredRunDeadlineSettlementTests } from "./subagent-registry.native-settlement.test-support.js";
import type { SubagentRegistrySeamFixture } from "./subagent-registry.seam-fixture.test-support.js";

export function registerUnconfirmedChildPromotionTests(fixture: SubagentRegistrySeamFixture) {
  const {
    findRequesterRun,
    getLifecycleHandler,
    getRegistry,
    hydrateAndActivateRegistry,
    mockAgentWait,
    mockPendingAgentWait,
    mocks,
    observerTerminalSignals,
    settleLifecycle,
  } = fixture;
  const { mockRestoredRuns } = mocks;
  const registry = () => getRegistry();

  it("skips silent-cleanup session deletion for an unconfirmed child but keeps it for an observed stop", async () => {
    const sessionStore = () =>
      createSessionStore({
        updatedAt: Date.now(),
        sessionId: "sess-silent",
        lifecycleRevision: "rev-silent",
      });
    const deleteCalls = () =>
      mocks.callGateway.mock.calls.filter(([request]) => request.method === "sessions.delete");

    // The silent path (expectsCompletionMessage: false) submits sessions.delete
    // itself rather than delegating to the announce flow, so it needs its own
    // coverage. Both identities are present, so a skipped delete can only come
    // from the disposition — see the observed-stop half below.
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        return { status: "timeout" };
      }
      return {};
    });
    mocks.entries = sessionStore();
    await registry().registerSubagentRun({
      runId: "run-unconfirmed-silent-cleanup",
      task: "unconfirmed silent cleanup",
      cleanup: "delete",
      expectsCompletionMessage: false,
      runTimeoutSeconds: 1,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    // Settled either way: the fix keeps the row (cleanup downgraded to keep, so
    // it is not retired), the unfixed path retires it after deleting. Waiting on
    // "settled" rather than on the row keeps the delete assertion below the one
    // that fails when the fix is absent.
    await waitForFast(() => {
      const run = findRequesterRun("run-unconfirmed-silent-cleanup");
      expect(run?.waitExpiryObservedAt).toEqual(expect.any(Number));
    });
    expect(deleteCalls()).toHaveLength(0);
    expect(findRequesterRun("run-unconfirmed-silent-cleanup")?.waitExpiryObservedAt).toEqual(
      expect.any(Number),
    );

    // Same run shape, same session identities, but agent.wait now carries a
    // terminal snapshot. Deletion must still happen, or the fix has simply
    // disabled delete-mode cleanup.
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        return { status: "timeout", stopReason: "run_timeout", endedAt: Date.now() };
      }
      return {};
    });
    mocks.entries = sessionStore();
    await registry().registerSubagentRun({
      runId: "run-observed-silent-cleanup",
      task: "observed silent cleanup",
      cleanup: "delete",
      expectsCompletionMessage: false,
    });
    await waitForFast(() => {
      expect(deleteCalls()).toHaveLength(1);
    });
  });

  it("marks a run timeout as an observed child stop when agent.wait carries a terminal snapshot", async () => {
    let waitAttempts = 0;
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        waitAttempts += 1;
        // stopReason/endedAt only come from a terminal snapshot, so unlike a
        // bare wait expiry this really is the child's own run ending.
        return { status: "timeout", stopReason: "run_timeout", startedAt: 111, endedAt: 222 };
      }
      return {};
    });
    mocks.entries = createSessionStore({});

    await registry().registerSubagentRun({
      runId: "run-observed-timeout",
      task: "observed stop",
    });

    await waitForFast(() => {
      const completedRun = findRequesterRun("run-observed-timeout");
      expect(waitAttempts).toBeGreaterThanOrEqual(1);
      expectRecordFields(
        completedRun?.execution.outcome,
        { status: "timeout", disposition: "exited" },
        "observed run timeout outcome",
      );
    });
  });

  // NOTE: upstream's "keeps published timeout stable when pre-deadline success
  // arrives late" case lived here and was removed on this branch, together with
  // the two "caps ... wait timeouts to the explicit deadline" rows below. All
  // three assert that a NON-terminal `agent.wait` timeout is capped into a
  // terminal completion at the stored deadline — the exact behavior this PR
  // exists to remove, because reaching our own budget is not evidence the child
  // stopped. The 2026-10-08 `origin/main` merge resurrected them. Their
  // replacements under the new contract are the
  // "does not terminally time out plain agent.wait timeouts before the observed
  // run deadline" / "uses running session-store start time for plain agent.wait
  // timeouts" rows further down.

  it("refreshes unpublished timeout delivery payloads after lifecycle correction", async () => {
    const createdAt = Date.parse("2026-03-24T11:59:00Z");
    mockPendingAgentWait();
    mocks.runSubagentAnnounceFlow.mockResolvedValueOnce("retryable");
    await registry().registerSubagentRun({
      runId: "run-refresh-pending-timeout-payload",
      task: "pending timeout payload should refresh",
      runTimeoutSeconds: 60,
    });
    await updateFixtureRun("run-refresh-pending-timeout-payload", (next) =>
      Object.assign(next, {
        createdAt,
        sessionStartedAt: createdAt,
        execution: {
          status: "terminal",
          startedAt: createdAt,
          endedAt: createdAt + 60_000,
          outcome: {
            status: "timeout",
            startedAt: createdAt,
            endedAt: createdAt + 60_000,
            elapsedMs: 60_000,
          },
        },
        delivery: {
          status: "pending",
          payload: {
            requesterSessionKey: "agent:main:main",
            childSessionKey: "agent:main:subagent:child",
            childRunId: "run-refresh-pending-timeout-payload",
            task: "pending timeout payload should refresh",
            startedAt: createdAt,
            endedAt: createdAt + 60_000,
            outcome: { status: "timeout" },
          },
        },
      }),
    );

    await settleLifecycle({
      runId: "run-refresh-pending-timeout-payload",
      stream: "lifecycle",
      data: {
        phase: "end",
        startedAt: createdAt + 10_000,
        endedAt: createdAt + 65_000,
      },
    });

    expect(mocks.runSubagentAnnounceFlow).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        childRunId: "run-refresh-pending-timeout-payload",
        outcome: expect.objectContaining({
          status: "ok",
          startedAt: createdAt + 10_000,
          endedAt: createdAt + 65_000,
          elapsedMs: 55_000,
        }),
      }),
    );
  });

  it.each([
    {
      name: "caps lifecycle timeouts to the explicit deadline",
      source: "lifecycle",
      duration: 1_000,
    },
    {
      name: "prefers explicit run timeout over late restored agent.wait success",
      source: "restored success",
      now: 61_000,
    },
    {
      name: "ignores stale session-store start time for fresh terminal completions",
      source: "session",
      waitNow: 61_000,
      sessionStart: -60_000,
      sessionEnd: 30_000,
      expectedStatus: "ok",
      expectedEnd: 30_000,
    },
    {
      name: "applies explicit timeout to terminal session rows without startedAt",
      source: "session",
      waitNow: 61_000,
      sessionEnd: 61_000,
    },
  ])(
    "$name",
    async ({
      source,
      duration = 60_000,
      now = 0,
      waitNow,
      sessionStart,
      sessionEnd,
      expectedStatus = "timeout",
      expectedEnd = duration,
    }) => {
      const runId = "run-explicit-deadline";
      const createdAt = Date.parse(
        source === "session" ? "2026-03-24T12:00:00Z" : "2026-03-24T11:59:00Z",
      );
      vi.setSystemTime(createdAt + now);
      const waitTimeouts: unknown[] = [];
      if (source === "lifecycle") {
        mockPendingAgentWait();
      } else {
        mockAgentWait((request) => {
          waitTimeouts.push(request.params?.timeoutMs);
          if (waitNow !== undefined) {
            vi.setSystemTime(createdAt + waitNow);
          }
          return source === "restored success"
            ? { status: "ok", startedAt: createdAt, endedAt: createdAt + 61_000 }
            : { status: "timeout" };
        });
      }
      if (source === "boundary wait" || source === "session") {
        mocks.entries = {
          "agent:main:subagent:child": createSessionEntry({
            status: source === "session" ? "done" : undefined,
            updatedAt: createdAt + (sessionEnd ?? 0),
            ...(sessionStart === undefined ? {} : { startedAt: createdAt + sessionStart }),
            ...(sessionEnd === undefined ? {} : { endedAt: createdAt + sessionEnd }),
          }),
        };
      }
      const settleRootWork = observeRootWork();
      try {
        if (source.startsWith("restored")) {
          mocks.resolveAgentTimeoutMs.mockReturnValue(60_000);
          mockRestoredRuns(() => [
            createSubagentRunRecord({
              runId,
              task: "resume near explicit timeout",
              runTimeoutSeconds: duration / 1_000,
              createdAt,
              startedAt: createdAt,
              sessionStartedAt: createdAt,
            }),
          ]);
          await hydrateAndActivateRegistry();
        } else {
          await registry().registerSubagentRun({
            runId,
            task: "honor explicit run deadline",
            runTimeoutSeconds: duration / 1_000,
          });
          if (source === "lifecycle") {
            getLifecycleHandler()({
              runId,
              stream: "lifecycle",
              data: {
                phase: "end",
                startedAt: createdAt,
                endedAt: createdAt + 2_000,
                aborted: true,
              },
            });
            await vi.advanceTimersByTimeAsync(30_000);
          }
        }
        await waitForFast(() => {
          expect(findRequesterRun(runId)?.execution).toMatchObject({
            endedAt: createdAt + expectedEnd,
            outcome: {
              status: expectedStatus,
              startedAt: createdAt,
              endedAt: createdAt + expectedEnd,
              elapsedMs: expectedEnd,
            },
          });
        });
      } finally {
        await settleRootWork();
      }
      if (source === "restored wait") {
        expect(waitTimeouts).toEqual([1_000]);
      } else if (source === "boundary wait") {
        expect(waitTimeouts).toHaveLength(1);
      }
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    },
  );

  it("promotes an unconfirmed explicit timeout when a late lifecycle abort observes the stop", async () => {
    const startedAt = Date.now();
    mockGatewayMethods(mocks.callGateway, { "agent.wait": { status: "timeout" } });
    mocks.entries = {
      "agent:main:subagent:child": createSessionEntry({
        updatedAt: startedAt,
      }),
    };

    const settleRootWork = observeRootWork();
    await registry().registerSubagentRun({
      runId: "run-timeout-late-lifecycle-timeout",
      task: "published timeout should ignore late timeout",
      runTimeoutSeconds: 1,
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await waitForFast(() => {
      const completedRun = findRequesterRun("run-timeout-late-lifecycle-timeout");
      expect(completedRun?.execution.endedAt).toBeUndefined();
      expect(completedRun?.waitExpiryObservedAt).toBe(startedAt + 1_000);
    });
    // Round 3: while unconfirmed, no durable terminal signal reaches an observer.
    expect(await observerTerminalSignals("run-timeout-late-lifecycle-timeout")).toEqual([]);

    const lifecycleHandler = getLifecycleHandler();

    lifecycleHandler?.({
      runId: "run-timeout-late-lifecycle-timeout",
      stream: "lifecycle",
      data: {
        phase: "end",
        startedAt: startedAt + 10,
        endedAt: startedAt + 2_000,
        aborted: true,
      },
    });
    await vi.advanceTimersByTimeAsync(30_000);

    // Regression (openclaw-odqn round 2, finding 1): this coverage previously
    // asserted the published timeout was frozen against every later callback,
    // which is exactly what made `child-unconfirmed` a state nothing could ever
    // leave. A lifecycle `end` with `aborted` IS an observed stop, so it must be
    // able to settle the row. The outcome stays a deadline-clamped timeout —
    // recomputed against the observed start the event reports — but the
    // disposition promotes, which is what re-arms terminal cleanup.
    await waitForFast(async () => {
      const run = findRequesterRun("run-timeout-late-lifecycle-timeout");
      expectRecordFields(
        run?.execution.outcome,
        {
          status: "timeout",
          startedAt: startedAt + 10,
          endedAt: startedAt + 1_010,
          elapsedMs: 1_000,
        },
        "promoted lifecycle timeout outcome",
      );
      expect(run?.execution.endedAt).toBe(startedAt + 1_010);
      // Round 3: promotion is also what publishes the terminal signal. This is
      // the push route (a late lifecycle event); the sweeper pull route is
      // covered separately, and both must land the claim exactly once.
      expect(await observerTerminalSignals("run-timeout-late-lifecycle-timeout")).toEqual([
        { kind: "run_failed", summary: "child run timed out", outcome: "timeout" },
      ]);
    });
    await settleRootWork();
    // The actual stop has its own terminal delivery after the provisional wake.
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(2);
  });

  it("keeps boundary wait expiry provisional until the lifecycle owner reports child end", async () => {
    const startedAt = Date.now();
    let waitAttempts = 0;
    mocks.captureSubagentCompletionReply.mockResolvedValue("PARTIAL before expiry");
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        waitAttempts += 1;
        vi.setSystemTime(startedAt + 999);
        return { status: "timeout" };
      }
      return {};
    });
    mocks.entries = {
      "agent:main:subagent:child": createSessionEntry({
        updatedAt: startedAt,
      }),
    };

    const settleRootWork = observeRootWork();
    await registry().registerSubagentRun({
      runId: "run-boundary-timeout",
      task: "deadline skew should still timeout",
      runTimeoutSeconds: 1,
    });

    await waitForFast(() => {
      const observedRun = findRequesterRun("run-boundary-timeout");
      expect(waitAttempts).toBe(1);
      expect(observedRun?.execution.status).toBe("running");
      expect(observedRun?.execution.endedAt).toBeUndefined();
      expect(observedRun?.waitExpiryObservedAt).toBe(startedAt + 1_000);
    });
    await waitForFast(() => expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1));
    expect(findRequesterRun("run-boundary-timeout")?.completion?.resultText).toBeUndefined();
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        deliveryPhase: "wait-expiry",
        outcome: { status: "timeout", disposition: "still-running" },
      }),
    );
    expect(mocks.cleanupBrowserSessionsForLifecycleEnd).not.toHaveBeenCalled();
    expect(mocks.onSubagentEnded).not.toHaveBeenCalled();

    getLifecycleHandler()({
      runId: "run-boundary-timeout",
      stream: "lifecycle",
      data: {
        phase: "end",
        startedAt,
        endedAt: startedAt + 1_250,
        terminalReply: { disposition: "visible", text: "FINAL after completion" },
      },
    });

    await waitForFast(() => {
      const completedRun = findRequesterRun("run-boundary-timeout");
      expect(completedRun?.execution.status).toBe("terminal");
      expect(completedRun?.execution.endedAt).toBe(startedAt + 1_250);
      expectRecordFields(
        completedRun?.execution.outcome,
        {
          status: "ok",
          startedAt,
          endedAt: startedAt + 1_250,
          elapsedMs: 1_250,
        },
        "authoritative post-expiry completion outcome",
      );
    });
    await waitForFast(() => {
      expect(mocks.cleanupBrowserSessionsForLifecycleEnd).toHaveBeenCalledTimes(1);
      expect(mocks.onSubagentEnded).toHaveBeenCalledTimes(1);
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(2);
      expect(findRequesterRun("run-boundary-timeout")?.completion?.resultText).toBe(
        "FINAL after completion",
      );
    });
    await settleRootWork();
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        roundOneReply: "FINAL after completion",
      }),
    );
    expect(
      (
        mocks.runSubagentAnnounceFlow.mock.calls as unknown as Array<[{ deliveryPhase?: string }]>
      )[1]?.[0],
    ).not.toMatchObject({
      deliveryPhase: "wait-expiry",
    });
  });

  // NOTE: upstream's "uses running session-store start time for plain wait
  // timeouts" case lived here. It asserts the same capped terminal completion
  // the rows above did, and the 2026-10-08 merge resurrected it; this branch
  // replaced it with the "uses running session-store start time for plain
  // agent.wait timeouts" row below, which asserts the observed start time is
  // honored WITHOUT terminalizing a child nothing observed to stop.

  it.each(["grace", "delivery", "rejected-delivery"] as const)(
    "does not publish retired wait-expiry state after lifecycle rotation during %s",
    async (rotationPhase) => {
      const startedAt = Date.now() - 1_000;
      mocks.callGateway.mockImplementation(async (request: { method?: string }) =>
        request.method === "agent.wait" ? { status: "timeout", startedAt } : {},
      );
      if (rotationPhase !== "grace") {
        mocks.runSubagentAnnounceFlow.mockImplementation(async () => {
          mocks.lifecycleGeneration = "rotated-generation";
          return rotationPhase === "rejected-delivery" ? "retryable" : "delivered";
        });
      }
      await registry().registerSubagentRun({
        runId: "run-expiry-retired-lifecycle",
        task: "do not let the retired waiter publish into the new Gateway generation",
        runTimeoutSeconds: 1,
      });
      // Settle the wait without advancing the grace timer: the same live row
      // survives the in-process restart while the wait's owner retires.
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.callGateway).toHaveBeenCalled();
      const beforeRotation = findRequesterRun("run-expiry-retired-lifecycle");
      expect(beforeRotation?.waitExpiryObservedAt).toBe(startedAt + 1_000);
      const persistedBeforeRotation = mocks.persistRegistryRows.mock.calls.length;
      if (rotationPhase === "grace") {
        mocks.lifecycleGeneration = "rotated-generation";
      }
      await vi.advanceTimersByTimeAsync(500);
      const run = findRequesterRun("run-expiry-retired-lifecycle");
      expect(run?.waitExpiryAnnouncedAt).toBeUndefined();
      expect(run?.execution.endedAt).toBeUndefined();
      if (rotationPhase === "grace") {
        expect(run?.waitExpiryObservedAt).toBe(startedAt + 1_000);
        expect(mocks.persistRegistryRows).toHaveBeenCalledTimes(persistedBeforeRotation);
        expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
      } else {
        expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledOnce();
      }
      expect(mocks.cleanupBrowserSessionsForLifecycleEnd).not.toHaveBeenCalled();
    },
  );

  it("keeps a child nonterminal when the sweeper runs during expiry announcement grace", async () => {
    const startedAt = Date.now();
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method !== "agent.wait") {
        return {};
      }
      vi.setSystemTime(startedAt + 1_000);
      return { status: "timeout", startedAt };
    });
    mocks.entries = createSessionStore({ updatedAt: startedAt });
    await registry().registerSubagentRun({
      runId: "run-expiry-grace-sweep",
      task: "preserve uncertainty before the provisional announcement",
      runTimeoutSeconds: 1,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
    await registry().testing.sweepOnceForTests();
    const run = findRequesterRun("run-expiry-grace-sweep");
    expect(run?.execution.endedAt).toBeUndefined();
    expect(run?.execution.outcome).toBeUndefined();
    expect(run?.waitExpiryObservedAt).toBe(startedAt + 1_000);
    expect(mocks.cleanupBrowserSessionsForLifecycleEnd).not.toHaveBeenCalled();

    getLifecycleHandler()({
      runId: "run-expiry-grace-sweep",
      stream: "lifecycle",
      data: { phase: "end", startedAt, endedAt: startedAt + 1_000 },
    });
    await vi.advanceTimersByTimeAsync(500);
    // Re-read: completion publishes a new row, so `run` above is the preimage.
    expect(findRequesterRun("run-expiry-grace-sweep")?.execution.status).toBe("terminal");
    // Completion commits the task through the real async task store before it
    // announces; that takes real time, not fake time.
    await vi.waitFor(() => expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledOnce(), {
      timeout: 15_000,
      interval: 50,
    });
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalledWith(
      expect.objectContaining({ deliveryPhase: "wait-expiry" }),
    );
  });

  it("retires a scheduled failed-delivery retry when the Gateway generation changes", async () => {
    const startedAt = Date.now() - 1_000;
    mocks.callGateway.mockImplementation(async (request: { method?: string }) =>
      request.method === "agent.wait" ? { status: "timeout", startedAt } : {},
    );
    mocks.runSubagentAnnounceFlow.mockResolvedValue("retryable");
    await registry().registerSubagentRun({
      runId: "run-expiry-retired-retry",
      task: "do not re-admit a retired wait after failed delivery",
      runTimeoutSeconds: 1,
    });
    // The grace delay is 250ms; the failed publish schedules a
    // distinct 25ms retry. Rotate after that retry is queued, before it fires.
    await vi.advanceTimersByTimeAsync(250);
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledOnce();
    const waitCount = mocks.callGateway.mock.calls.filter(
      ([request]) => request.method === "agent.wait",
    ).length;
    mocks.lifecycleGeneration = "rotated-generation";
    await vi.advanceTimersByTimeAsync(500);
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledOnce();
    expect(
      mocks.callGateway.mock.calls.filter(([request]) => request.method === "agent.wait"),
    ).toHaveLength(waitCount);
    expect(findRequesterRun("run-expiry-retired-retry")?.waitExpiryAnnouncedAt).toBeUndefined();
    expect(mocks.cleanupBrowserSessionsForLifecycleEnd).not.toHaveBeenCalled();
  });

  it.each(["intentional_non_delivery", "permanent_failure", "delivered"] as const)(
    "settles a provisional notification with %s without settling its child",
    async (notificationOutcome) => {
      const startedAt = Date.now() - 1_000;
      const runId = `run-expiry-settled-notification-${notificationOutcome}`;
      mocks.callGateway.mockImplementation(async (request: { method?: string }) =>
        request.method === "agent.wait" ? { status: "timeout", startedAt } : {},
      );
      mocks.runSubagentAnnounceFlow.mockResolvedValue(notificationOutcome);
      await registry().registerSubagentRun({
        runId,
        task: "do not retry a settled notification or finalize its live child",
        runTimeoutSeconds: 1,
      });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledOnce();
      const run = findRequesterRun(runId);
      expect(run?.waitExpiryAnnouncedAt).toEqual(expect.any(Number));
      expect(run?.execution.status).toBe("running");
      expect(run?.execution.endedAt).toBeUndefined();
      expect(run?.completion?.resultText).toBeUndefined();
      expect(mocks.cleanupBrowserSessionsForLifecycleEnd).not.toHaveBeenCalled();
      expect(mocks.onSubagentEnded).not.toHaveBeenCalled();
      expect(await observerTerminalSignals(runId)).toEqual([]);

      // Notification settlement must not suppress the child's later real result.
      getLifecycleHandler()({
        runId,
        stream: "lifecycle",
        data: {
          phase: "end",
          startedAt,
          endedAt: Date.now(),
          terminalReply: { disposition: "visible", text: "FINAL after notification settlement" },
        },
      });
      await waitForFast(() => {
        // Re-read each poll: the settling completion publishes a new row.
        const settled = findRequesterRun(runId);
        expect(settled?.execution.status).toBe("terminal");
        expect(settled?.completion?.resultText).toBe("FINAL after notification settlement");
        expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(2);
        expect(mocks.cleanupBrowserSessionsForLifecycleEnd).toHaveBeenCalledOnce();
      });
    },
  );

  it("retries a provisional wait-expiry announcement that was not delivered", async () => {
    const startedAt = Date.now() - 1_000;
    mocks.callGateway.mockImplementation(async (request: { method?: string }) =>
      request.method === "agent.wait" ? { status: "timeout", startedAt } : {},
    );
    mocks.runSubagentAnnounceFlow
      .mockResolvedValueOnce("retryable")
      .mockResolvedValueOnce("delivered");

    await registry().registerSubagentRun({
      runId: "run-wait-expiry-retryable-announce",
      task: "retry a deferred provisional wake",
      runTimeoutSeconds: 1,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await waitForFast(() => {
      const run = findRequesterRun("run-wait-expiry-retryable-announce");
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(2);
      expect(run?.execution.status).toBe("running");
      expect(run?.waitExpiryObservedAt).toBe(startedAt + 1_000);
      expect(run?.waitExpiryAnnouncedAt).toEqual(expect.any(Number));
    });
    expect(mocks.runSubagentAnnounceFlow.mock.calls).toEqual(
      expect.arrayContaining([[expect.objectContaining({ deliveryPhase: "wait-expiry" })]]),
    );
  });

  registerRestoredRunDeadlineSettlementTests({
    getRegistry,
    mocks,
    hydrateAndActivateRegistry,
  });
}
