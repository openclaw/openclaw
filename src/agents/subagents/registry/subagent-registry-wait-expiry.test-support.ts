// The wait manager publishes two different facts through one seam: "the child
// stopped" and "I stopped waiting for the child". These cases pin the second
// one as provisional — it wakes the parent without retiring the child.
import { expect, it, vi } from "vitest";
import type { AgentEventPayload } from "../../../infra/agent-events.js";
import {
  createSessionEntry,
  createSubagentRunRecord,
  expectRecordFields,
  mockCallArg as getMockCallArg,
  mockGatewayMethods,
  type SubagentRegistryHarness,
  waitForFast,
} from "../../subagent-test-fixtures.test-helpers.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import type { createSubagentRegistryMockState } from "./subagent-registry.mock-state.test-support.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function registerSubagentWaitExpiryTests(params: {
  getRegistry: () => SubagentRegistryHarness;
  getLifecycleHandler: () => (
    event: Pick<AgentEventPayload, "runId" | "stream" | "data"> & Partial<AgentEventPayload>,
  ) => void;
  mockPendingAgentWait: () => void;
  updateFixtureRun: (runId: string, update: (entry: SubagentRunRecord) => void) => Promise<void>;
  findRequesterRun: (runId: string, requesterSessionKey?: string) => SubagentRunRecord | undefined;
  mockRestoredRuns: (rows: () => SubagentRunRecord[]) => void;
  hydrateAndActivateRegistry: () => Promise<void>;
  mocks: ReturnType<typeof createSubagentRegistryMockState>;
}) {
  const {
    getLifecycleHandler,
    findRequesterRun,
    mockRestoredRuns,
    hydrateAndActivateRegistry,
    mockPendingAgentWait,
    updateFixtureRun,
    mocks,
  } = params;
  // Superseded by the "uses running session-store start time for plain
  // agent.wait timeouts" case below (same `run-plain-timeout-session-store-start`
  // fixture): a plain wait timeout now records a provisional expiry observation
  // instead of terminalizing the live child.

  it("keeps published explicit timeout stable when late lifecycle timeout arrives", async () => {
    const startedAt = Date.now();
    // A terminal snapshot on the wait proves the run itself stopped, so this
    // publication is final and a late duplicate must not disturb it.
    mockGatewayMethods(mocks.callGateway, {
      "agent.wait": { status: "timeout", endedAt: startedAt + 2_000 },
    });
    mocks.entries = {
      "agent:main:subagent:child": createSessionEntry({
        updatedAt: startedAt,
        status: undefined,
      }),
    };

    const settleRootWork = observeRootWork();
    await params.getRegistry().registerSubagentRun({
      runId: "run-timeout-late-lifecycle-timeout",
      task: "published timeout should ignore late timeout",
      runTimeoutSeconds: 1,
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await waitForFast(() => {
      const completedRun = findRequesterRun("run-timeout-late-lifecycle-timeout");
      expect(completedRun?.execution.endedAt).toBe(startedAt + 1_000);
      expect(completedRun?.execution.outcome?.status).toBe("timeout");
    });

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

    await waitForFast(() => {
      const run = findRequesterRun("run-timeout-late-lifecycle-timeout");
      expect(run?.execution.endedAt).toBe(startedAt + 1_000);
      expectRecordFields(
        run?.execution.outcome,
        {
          status: "timeout",
          startedAt,
          endedAt: startedAt + 1_000,
          elapsedMs: 1_000,
        },
        "stable published lifecycle timeout outcome",
      );
    });
    await settleRootWork();
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
  });

  it("keeps boundary wait expiry provisional until the lifecycle owner reports child end", async () => {
    const startedAt = Date.now();
    let waitAttempts = 0;
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
        status: undefined,
      }),
    };

    const settleRootWork = observeRootWork();
    await params.getRegistry().registerSubagentRun({
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
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    expect(mocks.cleanupBrowserSessionsForLifecycleEnd).not.toHaveBeenCalled();
    expect(mocks.onSubagentEnded).not.toHaveBeenCalled();

    getLifecycleHandler()({
      runId: "run-boundary-timeout",
      stream: "lifecycle",
      data: {
        phase: "end",
        startedAt,
        endedAt: startedAt + 1_250,
      },
    });

    await waitForFast(() => {
      const completedRun = findRequesterRun("run-boundary-timeout");
      expect(completedRun?.execution.status).toBe("terminal");
      expect(completedRun?.execution.endedAt).toBe(startedAt + 1_000);
      expectRecordFields(
        completedRun?.execution.outcome,
        {
          status: "timeout",
          startedAt,
          endedAt: startedAt + 1_000,
          elapsedMs: 1_000,
        },
        "lifecycle-owned boundary timeout outcome",
      );
    });
    await waitForFast(() => {
      expect(mocks.cleanupBrowserSessionsForLifecycleEnd).toHaveBeenCalledTimes(1);
      expect(mocks.onSubagentEnded).toHaveBeenCalledTimes(1);
    });
    await settleRootWork();
  });

  it.each(["grace", "delivery"] as const)(
    "does not publish retired wait-expiry state after lifecycle rotation during %s",
    async (rotationPhase) => {
      const startedAt = Date.now() - 1_000;
      mocks.callGateway.mockImplementation(async (request: { method?: string }) =>
        request.method === "agent.wait" ? { status: "timeout", startedAt } : {},
      );
      if (rotationPhase === "delivery") {
        mocks.runSubagentAnnounceFlow.mockImplementation(async () => {
          mocks.lifecycleGeneration = "rotated-generation";
          return "delivered";
        });
      }
      void params.getRegistry().registerSubagentRun({
        runId: "run-expiry-retired-lifecycle",
        task: "do not let the retired waiter publish into the new Gateway generation",
        runTimeoutSeconds: 1,
      });
      // Settle the wait without advancing the grace timer: the same live row
      // survives the in-process restart while the wait's owner retires.
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.callGateway).toHaveBeenCalled();
      if (rotationPhase === "grace") {
        mocks.lifecycleGeneration = "rotated-generation";
      }
      await vi.advanceTimersByTimeAsync(500);
      const run = findRequesterRun("run-expiry-retired-lifecycle");
      expect(run?.waitExpiryAnnouncedAt).toBeUndefined();
      expect(run?.execution.endedAt).toBeUndefined();
      if (rotationPhase === "grace") {
        expect(run?.waitExpiryObservedAt).toBeUndefined();
        expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
      } else {
        expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledOnce();
      }
      expect(mocks.cleanupBrowserSessionsForLifecycleEnd).not.toHaveBeenCalled();
    },
  );

  it.each(["intentional_non_delivery", "permanent_failure", "delivered"] as const)(
    "settles a provisional notification with %s without settling its child",
    async (notificationOutcome) => {
      const startedAt = Date.now() - 1_000;
      const runId = `run-expiry-settled-notification-${notificationOutcome}`;
      mocks.callGateway.mockImplementation(async (request: { method?: string }) =>
        request.method === "agent.wait" ? { status: "timeout", startedAt } : {},
      );
      mocks.runSubagentAnnounceFlow.mockResolvedValue(notificationOutcome);
      void params.getRegistry().registerSubagentRun({
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
      expect(run?.delivery?.deliveredAt).toBeUndefined();
      expect(mocks.patchSessionEntryCore).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledOnce();

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
        // Completion publishes a replacement row, so the settled state is read
        // from the registry rather than from the pre-completion `run`.
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

    void params.getRegistry().registerSubagentRun({
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

  it("settles the provisional notification through a committed row after a failed marker write", async () => {
    // Both markers are durable registry facts, so a rejected settlement write
    // must leave the notification pending and re-armed rather than reporting a
    // settlement that never reached the store.
    const startedAt = Date.now() - 1_000;
    const runId = "run-wait-expiry-settlement-write-failure";
    mocks.callGateway.mockImplementation(async (request: { method?: string }) =>
      request.method === "agent.wait" ? { status: "timeout", startedAt } : {},
    );
    let rejectedSettlementWrites = 0;
    let settlementWrites = 0;
    mocks.persistRegistryRows.mockImplementation((rows: Map<string, SubagentRunRecord>) => {
      if (![...rows.values()].some((row) => typeof row.waitExpiryAnnouncedAt === "number")) {
        return;
      }
      settlementWrites += 1;
      if (rejectedSettlementWrites === 0) {
        rejectedSettlementWrites += 1;
        throw new Error("disk full");
      }
    });

    void params.getRegistry().registerSubagentRun({
      runId,
      task: "retry the settlement marker until the store accepts it",
      runTimeoutSeconds: 1,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await waitForFast(() => {
      // The committed row is the receipt; the in-memory preimage is not.
      const run = findRequesterRun(runId);
      expect(rejectedSettlementWrites).toBe(1);
      expect(settlementWrites).toBeGreaterThanOrEqual(2);
      expect(run?.waitExpiryObservedAt).toBe(startedAt + 1_000);
      expect(run?.waitExpiryAnnouncedAt).toEqual(expect.any(Number));
      // The failed marker write is the waiter's problem, never the child's.
      expect(run?.execution.status).toBe("running");
      expect(run?.execution.endedAt).toBeUndefined();
    });
    expect(mocks.cleanupBrowserSessionsForLifecycleEnd).not.toHaveBeenCalled();
    expect(mocks.onSubagentEnded).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "uses running session-store start time for plain agent.wait timeouts",
      runId: "run-plain-timeout-session-store-start",
      task: "do not timeout before session store start deadline",
      initialNowAfterMs: 0,
      sessionStartedAfterMs: 10_000,
      observedStartedAfterMs: 10_000,
      sessionUpdatedAfterMs: 61_000,
      advanceOnFirstWait: true,
      expectTerminalReconciliation: false,
      label: "session store start plain wait timeout outcome",
    },
  ] as const)(
    "$name",
    async ({
      runId,
      task,
      initialNowAfterMs,
      sessionStartedAfterMs,
      observedStartedAfterMs,
      sessionUpdatedAfterMs,
      advanceOnFirstWait,
      expectTerminalReconciliation,
      label,
    }) => {
      const createdAt = Date.parse("2026-03-24T11:59:00Z");
      const observedStartedAt = createdAt + observedStartedAfterMs;
      vi.setSystemTime(createdAt + initialNowAfterMs);
      let waitAttempts = 0;
      mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
        if (request.method !== "agent.wait") {
          return {};
        }
        waitAttempts += 1;
        if (advanceOnFirstWait && waitAttempts === 1) {
          vi.setSystemTime(createdAt + 61_000);
        }
        return { status: "timeout" };
      });
      mocks.entries = {
        "agent:main:subagent:child": createSessionEntry({
          status: undefined,
          updatedAt: createdAt + sessionUpdatedAfterMs,
          ...(sessionStartedAfterMs === undefined
            ? {}
            : { startedAt: createdAt + sessionStartedAfterMs }),
        }),
      };

      const settleRootWork = observeRootWork();
      await params.getRegistry().registerSubagentRun({ runId, task, runTimeoutSeconds: 60 });

      await waitForFast(() => {
        const run = findRequesterRun(runId);
        expect(waitAttempts).toBeGreaterThanOrEqual(1);
        expect(run?.execution.endedAt).toBeUndefined();
        expect(run?.execution.outcome).toBeUndefined();
        expect(run?.execution.startedAt).toBe(observedStartedAt);
      });

      vi.setSystemTime(observedStartedAt + 60_000);
      await vi.advanceTimersByTimeAsync(5_000);

      await waitForFast(() => {
        const run = findRequesterRun(runId);
        if (expectTerminalReconciliation) {
          expect(run?.execution.endedAt).toBe(observedStartedAt + 60_000);
          expectRecordFields(
            run?.execution.outcome,
            {
              status: "timeout",
              startedAt: observedStartedAt,
              endedAt: observedStartedAt + 60_000,
              elapsedMs: 60_000,
            },
            label,
          );
        } else {
          expect(run?.execution.status).toBe("running");
          expect(run?.execution.endedAt).toBeUndefined();
          expect(run?.execution.outcome).toBeUndefined();
          expect(run?.waitExpiryObservedAt).toBe(observedStartedAt + 60_000);
        }
      });
      await settleRootWork();
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(
        expectTerminalReconciliation ? 2 : 1,
      );
    },
  );

  it("caps restored waits to the remaining explicit run timeout", async () => {
    const startedAt = Date.parse("2026-03-24T11:59:00Z");
    const runTimeoutSeconds = 60;
    vi.setSystemTime(startedAt + 59_000);
    mocks.resolveAgentTimeoutMs.mockReturnValue(60_000);
    mockRestoredRuns(() => [
      createSubagentRunRecord({
        runId: "run-resumed-near-deadline",
        task: "resume near explicit timeout",
        runTimeoutSeconds,
        createdAt: startedAt,
        startedAt,
        sessionStartedAt: startedAt,
      }),
    ]);
    const waitTimeouts: unknown[] = [];
    mocks.callGateway.mockImplementation(
      async (request: { method?: string; params?: Record<string, unknown> }) => {
        if (request.method === "agent.wait") {
          waitTimeouts.push(request.params?.timeoutMs);
          vi.setSystemTime(startedAt + 60_000);
          return { status: "timeout" };
        }
        return {};
      },
    );

    const settleRootWork = observeRootWork();
    await hydrateAndActivateRegistry();

    await waitForFast(() => {
      expect(waitTimeouts).toEqual([1_000]);
      const completedRun = findRequesterRun("run-resumed-near-deadline");
      expect(completedRun?.execution.status).toBe("running");
      expect(completedRun?.execution.endedAt).toBeUndefined();
      expect(completedRun?.execution.outcome).toBeUndefined();
      expect(completedRun?.waitExpiryObservedAt).toBe(startedAt + 60_000);
    });
    await settleRootWork();
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "uses observed agent.wait start time when capping terminal timeout",
      runId: "run-terminal-timeout-observed-start",
      task: "cap timeout using observed start",
      initialNowAfterMs: 75_000,
      waitStartedAfterMs: 10_000,
      waitEndedAfterMs: 75_000,
      sessionUpdatedAfterMs: 0,
      runTimeoutSeconds: 60,
      label: "observed start capped terminal timeout outcome",
    },
  ] as const)(
    "$name",
    async ({
      runId,
      task,
      initialNowAfterMs,
      waitStartedAfterMs,
      waitEndedAfterMs,
      sessionUpdatedAfterMs,
      runTimeoutSeconds,
      label,
    }) => {
      const createdAt = Date.parse("2026-03-24T11:59:00Z");
      const startedAt = createdAt + waitStartedAfterMs;
      const elapsedMs = runTimeoutSeconds * 1_000;
      vi.setSystemTime(createdAt + initialNowAfterMs);
      mockGatewayMethods(mocks.callGateway, {
        "agent.wait": {
          status: "timeout",
          startedAt,
          endedAt: createdAt + waitEndedAfterMs,
          stopReason: "rpc",
        },
      });
      mocks.entries = {
        "agent:main:subagent:child": createSessionEntry({
          updatedAt: createdAt + sessionUpdatedAfterMs,
          status: undefined,
        }),
      };

      const settleRootWork = observeRootWork();
      await params.getRegistry().registerSubagentRun({ runId, task, runTimeoutSeconds });

      await waitForFast(() => {
        const run = findRequesterRun(runId);
        expect(run?.execution.endedAt).toBe(startedAt + elapsedMs);
        expectRecordFields(
          run?.execution.outcome,
          { status: "timeout", startedAt, endedAt: startedAt + elapsedMs, elapsedMs },
          label,
        );
      });
      await settleRootWork();
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    },
  );

  // `rpc` is a cancellation only on a non-ok wait; a model/ACP "stop" that ends
  // an otherwise successful wait is a normal completion. `aborted` and
  // `superseded` are cancellations from their reason alone.
  it.each([
    { stopReason: "rpc", status: "error" },
    { stopReason: "aborted", status: "ok" },
    { stopReason: "superseded", status: "ok" },
  ] as const)(
    "publishes $stopReason agent.wait snapshots only after killed reconciliation",
    async ({ stopReason, status }) => {
      mockGatewayMethods(mocks.callGateway, {
        "agent.wait": {
          status,
          startedAt: 100,
          endedAt: 250,
          stopReason,
        },
      });

      await params.getRegistry().registerSubagentRun({
        runId: `run-${stopReason}-wait`,
        task: "aborted wait",
        expectsCompletionMessage: true,
      });

      await waitForFast(() => {
        const run = findRequesterRun(`run-${stopReason}-wait`);
        expect(run?.endedReason).toBe("subagent-killed");
        expect(run?.suppressAnnounceReason).toBe("killed");
      });
      expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();

      await params.getRegistry().testing.sweepOnceForTests();
      await waitForFast(() => expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1));
      const announceParams = expectRecordFields(
        getMockCallArg(mocks.runSubagentAnnounceFlow, 0, 0, "aborted wait announce"),
        { childRunId: `run-${stopReason}-wait` },
        "aborted wait announce params",
      );
      expectRecordFields(
        announceParams.outcome,
        {
          status: "error",
          disposition: "killed",
          error: "subagent run terminated",
          startedAt: 100,
          endedAt: 250,
          elapsedMs: 150,
        },
        "aborted wait announce outcome",
      );

      await waitForFast(() => {
        expect(
          params
            .getRegistry()
            .listSubagentRunsForRequester("agent:main:main")
            .some((entry) => entry.runId === `run-${stopReason}-wait`),
        ).toBe(false);
      });
    },
  );

  it("reconciles a provisionally announced run from persisted terminal state during sweep", async () => {
    mockPendingAgentWait();
    const persistedStartedAt = Date.parse("2026-03-24T11:58:00Z");
    const persistedEndedAt = persistedStartedAt + 111;
    mocks.entries = {
      "agent:main:subagent:child": createSessionEntry({
        updatedAt: persistedEndedAt,
        status: "done",
        startedAt: persistedStartedAt,
        endedAt: persistedEndedAt,
        runtimeMs: 111,
      }),
    };

    vi.setSystemTime(persistedStartedAt - 1);
    await params.getRegistry().registerSubagentRun({
      runId: "run-stale-terminal",
      task: "settle from persisted terminal state",
    });
    // Published rows are frozen, so the provisional markers are committed
    // through the registry worker exactly as the expiry reporter commits them.
    await updateFixtureRun("run-stale-terminal", (next) => {
      next.waitExpiryObservedAt = persistedStartedAt + 60_000;
      next.waitExpiryAnnouncedAt = persistedStartedAt + 60_001;
    });

    vi.setSystemTime(new Date("2026-03-24T12:02:00Z"));
    await params.getRegistry().testing.sweepOnceForTests();

    await waitForFast(() => {
      // The sweep also announces unrelated fixture runs, so select this run's
      // call rather than assuming it announced first.
      const calls = mocks.runSubagentAnnounceFlow.mock.calls as unknown as Record<
        string,
        unknown
      >[][];
      const announceParams = expectRecordFields(
        getMockCallArg(
          mocks.runSubagentAnnounceFlow,
          calls.findIndex(([announceCall]) => announceCall?.childRunId === "run-stale-terminal"),
          0,
          "stale terminal announce",
        ),
        { childRunId: "run-stale-terminal" },
        "stale terminal announce",
      );
      expectRecordFields(
        announceParams.outcome,
        { status: "ok", endedAt: persistedEndedAt },
        "stale terminal announce outcome",
      );
    });

    const run = findRequesterRun("run-stale-terminal");
    expect(run?.execution.endedAt).toBe(persistedEndedAt);
    expectRecordFields(
      run?.execution.outcome,
      {
        status: "ok",
        endedAt: persistedEndedAt,
      },
      "stale terminal run outcome",
    );
    // Cleanup publishes another replacement row, so re-read it each poll.
    await waitForFast(() =>
      expect(findRequesterRun("run-stale-terminal")?.cleanupCompletedAt).toBeTypeOf("number"),
    );
  });
}
