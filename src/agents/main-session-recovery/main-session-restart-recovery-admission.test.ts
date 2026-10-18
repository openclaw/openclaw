import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createGatewayCrashLoopRecovery } from "../../cli/gateway-cli/crash-loop-recovery.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/io.js";
import {
  patchSessionEntryCore,
  loadSessionEntry,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { callGateway } from "../../gateway/call.js";
import { createChannelAutostartRecovery } from "../../gateway/server-channel-autostart-recovery.js";
import { createGatewayInstanceRuntime } from "../../gateway/server-instance-runtime.js";
import { markGatewayStartupMainSessionOrphans } from "../../gateway/server-startup-observers.js";
import * as transcriptReaders from "../../gateway/session-transcript-readers.js";
import {
  resetAgentEventsForTest,
  rotateAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import {
  completeGatewayBootLifecycle,
  beginGatewayBootLifecycle,
} from "../../infra/gateway-boot-lifecycle.js";
import * as bootLifecycle from "../../infra/gateway-boot-lifecycle.js";
import * as gatewayWorkAdmission from "../../process/gateway-work-admission.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../../process/gateway-work-admission.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import { getExistingSessionControllerMailbox } from "../../sessions/session-controller.mailbox.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { createRecoveryRuntimeFixture } from "./main-session-recovery-runtime.test-support.js";
import * as recoveryTargets from "./main-session-restart-recovery-exact-target.js";
import {
  createRestartRecoveryStoreFixture,
  makePendingFinalDelivery,
} from "./main-session-restart-recovery-fixture.test-support.js";
import { mainSessionRecoveryLog } from "./main-session-restart-recovery-shared.js";
import {
  retryRestartAbortedMainSessionRecovery as retryRecovery,
  scheduleRestartAbortedMainSessionRecovery,
} from "./main-session-restart-recovery.js";

vi.mock("../../gateway/call.js", () => ({
  callGateway: vi.fn(async () => ({ runId: "run-resumed" })),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let dispatchSettlement = createDeferred();
const gatewayRuntime = createRecoveryRuntimeFixture({
  callGateway,
  getDispatchSettlement: () => dispatchSettlement.promise,
  sendRecoveryNotice: async () => ({ suppressed: false }),
});

/** Reads the durable reservation at the moment the resend's mailbox input settles. */
function observeReservationAtResendSettlement(params: {
  storePath: string;
  sessionKey: string;
  runId: unknown;
}) {
  const input = getExistingSessionControllerMailbox(
    params.sessionKey,
    captureSessionTarget({ storeScope: params.storePath, sessionKey: params.sessionKey }),
  )?.entries.find((entry) => entry.protocolRunId === params.runId);
  expect(input, "the resend must be a mailbox input").toBeDefined();
  return input!.settlement.promise.then(
    () => loadSessionEntry(params)?.mainRestartRecovery?.reservation,
  );
}

describe("startup recovery admission", () => {
  let tmpDir: string;
  const { makeMainSessionFixture, writeCompletedToolTranscript } =
    createRestartRecoveryStoreFixture(() => tmpDir);
  const recoveryCleanups: Array<() => Promise<void>> = [];

  function finalAttempt(
    cycleId: string,
    overrides: Parameters<typeof makeMainSessionFixture>[0] = {},
  ) {
    return makeMainSessionFixture({
      mainRestartRecovery: { cycleId, revision: 1, chargedAttempts: 2 },
      pendingFinalDelivery: makePendingFinalDelivery(),
      ...overrides,
    });
  }

  function schedule(
    options: Partial<Parameters<typeof scheduleRestartAbortedMainSessionRecovery>[0]> = {},
    release: () => void = () => {},
  ) {
    const recovery = scheduleRestartAbortedMainSessionRecovery({
      getConfig: () => ({}),
      delayMs: 0,
      stateDir: tmpDir,
      gatewayRuntime,
      ...options,
    });
    recoveryCleanups.push(async () => {
      release();
      dispatchSettlement.resolve();
      await recovery.stop();
    });
    return recovery;
  }

  function observeAdmission(
    settled: (origin: string | undefined, attempt: number) => void,
    entered?: (origin?: string) => void,
  ) {
    const admit = gatewayWorkAdmission.runWithGatewayIndependentRootWorkAdmission;
    let attempt = 0;
    return vi
      .spyOn(gatewayWorkAdmission, "runWithGatewayIndependentRootWorkAdmission")
      .mockImplementation(
        async <T>(run: () => Promise<T>, origin?: string, signal?: AbortSignal) => {
          const ordinal = attempt++;
          try {
            const admitted = admit(run, origin, signal);
            entered?.(origin);
            return await admitted;
          } finally {
            settled(origin, ordinal);
          }
        },
      );
  }

  function observeInfo(handlers: Record<string, () => void>) {
    return vi.spyOn(mainSessionRecoveryLog, "info").mockImplementation((line) => {
      for (const [fragment, handler] of Object.entries(handlers)) {
        if (line.includes(fragment)) {
          handler();
        }
      }
    });
  }

  function trackPreparation<Args extends unknown[], Result>(
    run: (...args: Args) => Promise<Result>,
  ) {
    let active = 0;
    const tracker = {
      peak: 0,
      run: async (...args: Args) => {
        tracker.peak = Math.max(tracker.peak, ++active);
        try {
          return await run(...args);
        } finally {
          active--;
        }
      },
    };
    return tracker;
  }

  function failDispatch() {
    vi.mocked(callGateway).mockImplementation(async ({ method }) => {
      if (method === "agent") {
        throw new Error("final ambiguous dispatch failure");
      }
      return { status: "timeout" };
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(callGateway).mockReset().mockResolvedValue({ runId: "run-resumed" });
    dispatchSettlement = createDeferred();
    resetAgentEventsForTest();
    resetGatewayWorkAdmission();
    tmpDir = tempDirs.make("openclaw-recovery-admission-");
    setRuntimeConfigSnapshot({});
  });

  afterEach(async () => {
    try {
      for (const cleanup of recoveryCleanups.splice(0)) {
        await cleanup();
      }
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
      resetGatewayWorkAdmission();
      await cleanupSessionStateForTest({ stateDir: tmpDir });
      clearRuntimeConfigSnapshot();
    }
  });

  it.for(["resume", "crash", "stop", "replace", "healthy"] as const)(
    "preserves interrupted turns through crash-loop quarantine (%s)",
    async (action, { signal }) => {
      const target = await makeMainSessionFixture({
        mainRestartRecovery: { cycleId: "paused-cycle", revision: 1, chargedAttempts: 2 },
      });
      await writeCompletedToolTranscript(target.sessionsDir);
      const before = structuredClone(loadSessionEntry(target));
      const env = { ...process.env, OPENCLAW_STATE_DIR: tmpDir };
      const now = Date.now();
      let activeBootId: string | undefined;
      const healthy = action === "healthy";
      // Two previous crashes plus the live boot must not independently trip safe mode.
      for (let i = 0; i < (healthy ? 2 : 3); i++) {
        const failedAt = now - (healthy ? 1_000 : 295_000) + i;
        const boot = (await beginGatewayBootLifecycle(env, failedAt)).id;
        await completeGatewayBootLifecycle(boot, { outcome: "startup_failed" }, env, failedAt);
      }
      activeBootId = (await beginGatewayBootLifecycle(env, healthy ? now : now - 290_000)).id;
      const lifetime = new AbortController();
      let suppression: object | null =
        action === "healthy" ? null : { reason: "crash-loop-breaker" };
      const recoverBoot = createGatewayCrashLoopRecovery({
        bootId: activeBootId,
        getActiveBootId: () => activeBootId,
        onRecovered: (bootId) => {
          activeBootId = bootId;
        },
      });
      const runtime = {
        ...gatewayRuntime,
        prepareRestartRecovery: createChannelAutostartRecovery({
          signal: lifetime.signal,
          getSuppression: () => suppression,
          clearSuppression: () => {
            suppression = null;
          },
          tryRecover: (recoverySignal) =>
            withEnvAsync({ OPENCLAW_STATE_DIR: tmpDir }, () => recoverBoot(recoverySignal)),
          startChannels: async () => {},
        }),
      };
      const inspect = vi.spyOn(bootLifecycle, "inspectGatewayCrashLoopBreakerAsync");
      const recordRecovery = bootLifecycle.recordGatewayCrashLoopRecovery;
      // Workers retain real time; carry the lifecycle's fake clock through the writer input.
      vi.spyOn(bootLifecycle, "recordGatewayCrashLoopRecovery").mockImplementation(
        (bootId, recoveryEnv, _now, assertCurrent) =>
          recordRecovery(bootId, recoveryEnv, Date.now(), assertCurrent),
      );
      const startupCheckedStorePaths = new Set<string>();
      const notice = vi.spyOn(runtime, "sendRecoveryNotice");
      if (action === "resume") {
        await withEnvAsync({ OPENCLAW_STATE_DIR: tmpDir }, () =>
          markGatewayStartupMainSessionOrphans(
            {
              gatewayPluginConfigAtStart: {},
              isRestartRecoverySuppressed: () => suppression !== null,
              scheduler: lifetime,
              log: { warn: vi.fn() },
            },
            startupCheckedStorePaths,
          ),
        );
        expect(loadSessionEntry(target)).toEqual(before);
        expect(startupCheckedStorePaths.size).toBe(0);
      }
      const paused = createDeferred();
      vi.spyOn(mainSessionRecoveryLog, "warn").mockImplementation((message) => {
        paused.reject(new Error(message));
      });
      const completed = createDeferred();
      const dispatched = createDeferred();
      const info = observeInfo({
        "restart recovery paused until": () => {
          if (!vi.isFakeTimers()) {
            vi.useFakeTimers();
            vi.setSystemTime(now);
          }
          paused.resolve();
        },
        "startup complete:": () => completed.resolve(),
      });
      vi.mocked(callGateway).mockImplementation(async () => {
        dispatched.resolve();
        return { runId: "run-resumed" };
      });
      const recovery = schedule({ startupCheckedStorePaths, gatewayRuntime: runtime }, () =>
        lifetime.abort(),
      );
      if (action === "healthy") {
        await withinTest(completed.promise, signal);
        expect(callGateway).toHaveBeenCalledOnce();
        expect(inspect).not.toHaveBeenCalled();
        return;
      }
      await withinTest(Promise.race([paused.promise, dispatched.promise]), signal);
      expect(callGateway).not.toHaveBeenCalled();
      expect(loadSessionEntry(target)).toEqual(before);
      expect(
        info.mock.calls.filter(([line]) => line.includes("restart recovery paused until")),
      ).toEqual([[expect.stringContaining(new Date(now + 10_001).toISOString())]]);
      expect(notice).not.toHaveBeenCalled();
      if (action === "resume") {
        await expect(
          retryRecovery({
            ...target,
            expectedSessionId: "main-session",
            stateDir: tmpDir,
            gatewayRuntime: runtime,
          }),
        ).resolves.toEqual({ started: 0, settled: 0, failed: 0, skipped: 0 });
        expect(loadSessionEntry(target)).toEqual(before);
      }
      if (action === "stop") {
        await recovery.stop();
      }
      if (action === "replace") {
        rotateAgentEventLifecycleGeneration();
      }
      const extendedPause = createDeferred();
      if (action === "crash") {
        const boot = (await beginGatewayBootLifecycle(env, now)).id;
        await completeGatewayBootLifecycle(boot, { outcome: "startup_failed" }, env, now);
        info.mockImplementation((message) => {
          if (message.includes("restart recovery paused until")) {
            extendedPause.resolve();
          }
        });
      }
      await vi.advanceTimersByTimeAsync(10_002);
      if (action === "resume") {
        await withinTest(completed.promise, signal);
        expect(callGateway).toHaveBeenCalledOnce();
        expect(loadSessionEntry(target)?.abortedLastRun).toBe(false);
        await vi.advanceTimersByTimeAsync(20_000);
        expect(callGateway).toHaveBeenCalledOnce();
      } else {
        if (action === "crash") {
          await withinTest(extendedPause.promise, signal);
        }
        expect(callGateway).not.toHaveBeenCalled();
        expect(loadSessionEntry(target)).toEqual(before);
      }
    },
  );

  it.each([false, true])(
    "does not inspect the breaker for exact-target recovery (closed=%s)",
    async (closed) => {
      const target = await makeMainSessionFixture();
      await writeCompletedToolTranscript(target.sessionsDir);
      const before = structuredClone(loadSessionEntry(target));
      const unused = () => {
        throw new Error("Preparation must not dispatch through the instance facade");
      };
      const instance = createGatewayInstanceRuntime({
        getContext: unused,
        getMethodRegistry: unused,
        isDispatchAvailable: () => !closed,
      });
      const inspect = vi.spyOn(bootLifecycle, "inspectGatewayCrashLoopBreakerAsync");
      dispatchSettlement.resolve();
      try {
        const recovery = retryRecovery({
          ...target,
          expectedSessionId: "main-session",
          stateDir: tmpDir,
          gatewayRuntime: {
            ...gatewayRuntime,
            prepareRestartRecovery: instance.recovery.prepareRestartRecovery,
          },
        });
        if (closed) {
          await expect(recovery).rejects.toThrow("Gateway instance dispatch unavailable");
          expect(callGateway).not.toHaveBeenCalled();
          expect(loadSessionEntry(target)).toEqual(before);
        } else {
          await expect(recovery).resolves.toMatchObject({ started: 1, failed: 0 });
          expect(callGateway).toHaveBeenCalledOnce();
        }
        expect(inspect).not.toHaveBeenCalled();
      } finally {
        instance.close();
      }
    },
  );

  it("skips a recovery target replaced while runtime preparation waits", async () => {
    const { storePath, sessionKey } = await makeMainSessionFixture();
    const preparationEntered = createDeferred();
    const releasePreparation = createDeferred();
    const recovery = retryRecovery({
      expectedSessionId: "main-session",
      storePath,
      sessionKey,
      gatewayRuntime: {
        ...gatewayRuntime,
        prepareRestartRecovery: async () => {
          preparationEntered.resolve();
          await releasePreparation.promise;
          return undefined;
        },
      },
    });
    try {
      await preparationEntered.promise;
      await replaceSessionEntry(
        { storePath, sessionKey },
        { sessionId: "replacement-session", updatedAt: Date.now(), status: "done" },
      );
      releasePreparation.resolve();
      await expect(recovery).resolves.toEqual({ started: 0, settled: 0, failed: 0, skipped: 0 });
      expect(callGateway).not.toHaveBeenCalled();
      expect(loadSessionEntry({ storePath, sessionKey })).toMatchObject({
        sessionId: "replacement-session",
        status: "done",
      });
    } finally {
      releasePreparation.resolve();
      await recovery;
    }
  });

  it.for(["continue", "stop"] as const)(
    "bounds startup preparation without waiting for execution (%s)",
    async (action, { signal }) => {
      const first = await makeMainSessionFixture({ lifecycleRunId: "interrupted-main" });
      await writeCompletedToolTranscript(first.sessionsDir);
      const second = await makeMainSessionFixture({
        agentId: "other",
        sessionKey: "agent:other:main",
        sessionId: "other-session",
        pendingFinalDelivery: makePendingFinalDelivery(),
      });
      await makeMainSessionFixture({
        sessionKey: "agent:main:archived",
        sessionId: "archived-session",
        archivedAt: Date.now(),
      });
      await makeMainSessionFixture({
        sessionKey: "agent:main:subagent:child",
        sessionId: "child-session",
        spawnDepth: 1,
      });
      const info = vi.spyOn(mainSessionRecoveryLog, "info");
      const executionWait = createDeferred();
      const wait = gatewayRuntime.waitForAgent;
      const waitSpy = vi
        .spyOn(gatewayRuntime, "waitForAgent")
        .mockImplementation(async <T>(request: Record<string, unknown>, timeoutMs?: number) => {
          if (typeof request.timeoutMs === "number" && request.timeoutMs > 0) {
            executionWait.resolve();
            await dispatchSettlement.promise;
            return { status: "ok", endedAt: Date.now() } as T;
          }
          return await wait<T>(request, timeoutMs);
        });
      const prepared = createDeferred();
      const releasePreparation = createDeferred();
      const read = transcriptReaders.readSessionMessagesAsync;
      const preparation = trackPreparation(async (...args: Parameters<typeof read>) => {
        if (args[0].sessionId === "main-session") {
          prepared.resolve();
          await releasePreparation.promise;
        }
        return await read(...args);
      });
      const readSpy = vi
        .spyOn(transcriptReaders, "readSessionMessagesAsync")
        .mockImplementation(preparation.run);
      const passFinished = createDeferred();
      observeAdmission((origin) => {
        if (origin === "main-session:startup-recovery") {
          passFinished.resolve();
        }
      });
      const recovery = schedule(
        {
          getConfig: () => ({ agents: { entries: { main: {}, other: {} } } }),
        },
        () => releasePreparation.resolve(),
      );
      await withinTest(prepared.promise, signal);
      expect(callGateway).not.toHaveBeenCalled();
      expect(readSpy).toHaveBeenCalledOnce();
      let stopping: Promise<void> | undefined;
      if (action === "stop") {
        stopping = recovery.stop();
        expect(getActiveGatewayRootWorkCount()).toBe(1);
      }
      releasePreparation.resolve();
      // Execution remains held by dispatchSettlement until this test's cleanup.
      await withinTest(Promise.race([passFinished.promise, executionWait.promise]), signal);
      await stopping;
      expect(preparation.peak).toBe(1);
      expect(callGateway).toHaveBeenCalledTimes(action === "stop" ? 0 : 2);
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      for (const scope of [first, second]) {
        const entry = scope.readEntry();
        expect(entry?.status).toBe(action === "stop" ? "interrupted" : undefined);
        expect(entry).toMatchObject({
          abortedLastRun: action === "stop",
        });
      }
      if (action === "continue") {
        expect(waitSpy).not.toHaveBeenCalled();
        const lines = info.mock.calls.map(([line]) => line);
        expect(lines).toContainEqual(
          expect.stringMatching(/startup complete: started=2 .*skipReasons=.*not_main_session:1/),
        );
        const decisions = lines
          .filter((line) => line.startsWith("main-session restart recovery candidate "))
          .map((line) => JSON.parse(line.slice("main-session restart recovery candidate ".length)));
        expect(decisions).toHaveLength(2);
        expect(decisions).toContainEqual(
          expect.objectContaining({
            sessionKey: first.sessionKey,
            sourceRunId: "interrupted-main",
            decision: "started",
            nextOwner: "restart-recovery-lane",
            boot: expect.any(String),
            pass: expect.any(String),
          }),
        );
      }
      if (action === "stop") {
        const state = first.readEntry()?.mainRestartRecovery;
        expect(state?.chargedAttempts).toBe(0);
        expect(state?.reservation).toBeUndefined();
      }
    },
  );

  it.for([
    { field: "initializationPending", action: "resume", timing: "startup replay" },
    { field: "initializationPending", action: "resume", timing: "publication replay" },
    { field: "pendingProjectGitUrl", action: "resume", timing: "preparation commit" },
    { field: "pendingProjectGitUrl", action: "retry", timing: "preparation commit" },
    { field: "pendingProjectGitUrl", action: "archive", timing: "preparation commit" },
    { field: "initializationPending", action: "replace", timing: "preparation commit" },
  ] as const)(
    "handles $action when $field preparation finishes after startup ($timing)",
    async ({ field, action, timing }, { signal }) => {
      const target = await makeMainSessionFixture({
        [field]: field === "initializationPending" ? true : "https://example.test/project.git",
        pendingFinalDelivery: makePendingFinalDelivery(),
      });
      const startup = createDeferred();
      const resumed = createDeferred();
      const blocked = createDeferred();
      const failedAttempt = createDeferred();
      const firstPreparationSettled = createDeferred();
      const replayLoaded = createDeferred();
      const releaseReplay = createDeferred();
      let holdPreparationRead = timing === "startup replay";
      const loadTarget = recoveryTargets.loadExpectedRestartRecoveryTarget;
      const exactReads: Array<{
        sessionId?: string;
        initializationPending?: boolean;
      }> = [];
      vi.spyOn(recoveryTargets, "loadExpectedRestartRecoveryTarget").mockImplementation(
        async (params) => {
          const entry = await loadTarget(params);
          exactReads.push({
            sessionId: entry?.sessionId,
            initializationPending: entry?.initializationPending,
          });
          if (holdPreparationRead) {
            holdPreparationRead = false;
            // Finish preparation after recovery reads the row, before it handles that snapshot.
            replayLoaded.resolve();
            await releaseReplay.promise;
          }
          return entry;
        },
      );
      let failedRead = false;
      const readSpy = vi.spyOn(transcriptReaders, "readSessionMessagesAsync");
      if (action === "retry") {
        readSpy.mockImplementationOnce(async () => {
          failedRead = true;
          throw new Error("transcript temporarily unavailable");
        });
      }
      observeAdmission((origin) => {
        if (origin !== "main-session:preparation-recovery") {
          return;
        }
        if (holdPreparationRead) {
          holdPreparationRead = false;
          replayLoaded.reject(new Error("Preparation replay finished before reading its target"));
        }
        firstPreparationSettled.resolve();
        if (failedRead) {
          failedAttempt.resolve();
        }
      });
      const info = observeInfo({
        "startup complete:": () => startup.resolve(),
        '"reason":"archived"': () => blocked.resolve(),
      });
      vi.mocked(callGateway).mockImplementation(async () => {
        resumed.resolve();
        return { runId: "run-resumed" };
      });
      const recovery = schedule({}, () => releaseReplay.resolve());
      await withinTest(startup.promise, signal);
      expect(callGateway).not.toHaveBeenCalled();
      expect(loadSessionEntry(target)?.mainRestartRecovery?.chargedAttempts).toBe(0);
      if (action === "retry") {
        vi.useFakeTimers();
      }
      if (timing === "publication replay") {
        await withinTest(firstPreparationSettled.promise, signal);
        holdPreparationRead = true;
        await patchSessionEntryCore(target, () => ({ label: "preparation progress" }));
      }
      if (timing !== "preparation commit") {
        await withinTest(replayLoaded.promise, signal);
        expect(exactReads.at(-1)).toEqual({
          sessionId: "main-session",
          initializationPending: true,
        });
      }
      if (action === "replace") {
        await replaceSessionEntry(target, {
          sessionId: "replacement-session",
          updatedAt: Date.now(),
        });
        await recovery.stop();
        expect(callGateway).not.toHaveBeenCalled();
        expect(loadSessionEntry(target)?.sessionId).toBe("replacement-session");
      } else {
        await patchSessionEntryCore(target, () => ({
          [field]: undefined,
          ...(action === "archive" ? { archivedAt: Date.now() } : {}),
        }));
        releaseReplay.resolve();
        if (action === "retry") {
          await withinTest(failedAttempt.promise, signal);
          expect(callGateway).not.toHaveBeenCalled();
          expect(loadSessionEntry(target)?.mainRestartRecovery?.chargedAttempts).toBe(0);
          await vi.advanceTimersByTimeAsync(5_000);
        }
        await withinTest(action === "archive" ? blocked.promise : resumed.promise, signal);
        if (action === "resume" || action === "retry") {
          await gatewayRuntime.expectAdmission(1, recovery, target);
        } else {
          await recovery.stop();
        }
        expect(callGateway).toHaveBeenCalledTimes(action === "archive" ? 0 : 1);
        expect(loadSessionEntry(target)?.abortedLastRun).toBe(action === "archive");
      }
      const decisions = info.mock.calls.map(([line]) => line);
      expect(decisions).toContainEqual(expect.stringContaining('"decision":"deferred"'));
      expect(decisions).toContainEqual(
        expect.stringContaining('"nextOwner":"session-preparation"'),
      );
    },
  );

  it("admits each scheduled recovery attempt as independent root work", async () => {
    const { storePath, sessionKey } = await makeMainSessionFixture({
      pendingFinalDelivery: makePendingFinalDelivery(),
    });

    const suspensionRef: {
      current: ReturnType<typeof tryBeginGatewaySuspendAdmission>;
    } = { current: null };
    vi.mocked(callGateway)
      .mockImplementationOnce(async () => {
        expect(getActiveGatewayRootWorkCount()).toBe(1);
        suspensionRef.current = tryBeginGatewaySuspendAdmission(() => {});
        expect(suspensionRef.current?.commit()).toBe(true);
        throw new Error("retry after suspension");
      })
      .mockImplementationOnce(async () => {
        expect(getActiveGatewayRootWorkCount()).toBe(1);
        return { runId: "run-resumed", status: "timeout" };
      })
      .mockImplementationOnce(async () => {
        expect(getActiveGatewayRootWorkCount()).toBe(1);
        return { runId: "run-resumed" };
      });

    const firstAttempt = createDeferred();
    const secondAttempt = createDeferred();
    observeAdmission((_, attempt) => (attempt === 0 ? firstAttempt : secondAttempt).resolve());
    vi.useFakeTimers();
    schedule({ maxRetries: 2 }, () => {
      suspensionRef.current?.release();
    });

    await firstAttempt.promise;
    expect(callGateway).toHaveBeenCalledTimes(2);
    expect(getActiveGatewayRootWorkCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(callGateway).toHaveBeenCalledTimes(2);
    expect(getActiveGatewayRootWorkCount()).toBe(0);
    expect(suspensionRef.current?.release()).toBe(true);

    await secondAttempt.promise;
    expect(callGateway).toHaveBeenCalledTimes(3);
    const entry = loadSessionEntry({ storePath, sessionKey });
    expect(entry?.abortedLastRun).toBe(false);
    const runIds = vi
      .mocked(callGateway)
      .mock.calls.map(([request]) =>
        request.method === "agent"
          ? (request.params as { idempotencyKey?: unknown }).idempotencyKey
          : undefined,
      )
      .filter((runId) => runId !== undefined);
    expect(new Set(runIds).size).toBe(1);
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it.for([
    { name: "the final startup retry consumes the last charge", agentId: "main", dirs: ["main"] },
    {
      name: "distinct stores contain the same logical session",
      agentId: "ops",
      dirs: ["ops", " ops "],
    },
  ])("tombstones exhausted targets when $name", async ({ agentId, dirs }, { signal }) => {
    const run = async () => {
      const multipleStores = dirs.length > 1;
      const sessionKey = `agent:${agentId}:main`;
      const targets: Array<{ agentId: string; sessionKey: string; storePath: string }> = [];
      for (const [index, directory] of dirs.entries()) {
        const fixture = await finalAttempt(
          multipleStores ? `cycle-ops-${index}` : "cycle-final-startup-attempt",
          {
            agentId: directory,
            sessionKey,
            sessionId: multipleStores ? `ops-session-${index}` : "main-session",
          },
        );
        targets.push({ agentId, sessionKey, storePath: fixture.storePath });
      }
      const { storePath } = targets[0]!;
      let reservationAtSettlement: Promise<unknown> | undefined;
      if (multipleStores) {
        failDispatch();
      } else {
        vi.mocked(callGateway)
          .mockImplementationOnce(async (request) => {
            reservationAtSettlement = observeReservationAtResendSettlement({
              storePath,
              sessionKey,
              runId: (request.params as { idempotencyKey?: unknown }).idempotencyKey,
            });
            await replaceSessionEntry(
              { sessionKey: "agent:main:fresh", storePath },
              {
                sessionId: "fresh-session",
                updatedAt: Date.now(),
                status: "interrupted",
                abortedLastRun: true,
                mainRestartRecovery: {
                  cycleId: "cycle-fresh-exhausted",
                  revision: 1,
                  chargedAttempts: 3,
                },
              },
            );
            throw new Error("final ambiguous dispatch failure");
          })
          .mockResolvedValueOnce({ runId: "run-resumed" });
      }
      const recovery = schedule({
        getConfig: () => ({ agents: { entries: { [agentId]: {} } } }),
        maxRetries: 1,
      });
      await gatewayRuntime.expectFailedRecovery(2 * targets.length, recovery, signal, ...targets);
      for (const [index, target] of targets.entries()) {
        const entry = loadSessionEntry(target);
        expect(entry).toMatchObject({
          status: "failed",
          mainRestartRecovery: { tombstone: expect.any(Object) },
        });
        if (multipleStores) {
          expect(entry).toMatchObject({
            sessionId: `ops-session-${index}`,
            abortedLastRun: false,
            mainRestartRecovery: { chargedAttempts: 3 },
          });
          expect(entry?.mainRestartRecovery?.reservation).toBeUndefined();
        }
      }
      if (multipleStores) {
        expect(
          vi.mocked(callGateway).mock.calls.filter(([call]) => call.method === "agent"),
        ).toHaveLength(2);
      } else {
        // The failed attempt's rollback commits before its mailbox input settles.
        await expect(reservationAtSettlement).resolves.toBeUndefined();
        const freshEntry = loadSessionEntry({ sessionKey: "agent:main:fresh", storePath });
        expect(freshEntry).toMatchObject({
          sessionId: "fresh-session",
          status: "interrupted",
          abortedLastRun: true,
          mainRestartRecovery: { chargedAttempts: 3 },
        });
        expect(freshEntry?.mainRestartRecovery?.tombstone).toBeUndefined();
      }
    };
    await (dirs.length > 1 ? withEnvAsync({ OPENCLAW_STATE_DIR: tmpDir }, run) : run());
  });

  it("bounds exhausted-target reads and continues after one target fails", async ({ signal }) => {
    const targets: Awaited<ReturnType<typeof makeMainSessionFixture>>[] = [];
    for (const name of ["first", "second"]) {
      targets.push(
        await finalAttempt(`cycle-exhaustion-${name}`, {
          sessionKey: `agent:main:${name}`,
          sessionId: `${name}-session`,
        }),
      );
    }
    failDispatch();
    const entered = createDeferred();
    const release = createDeferred();
    const prepare = recoveryTargets.prepareExpectedRestartRecoveryCurrent;
    const preparedKeys: string[] = [];
    const preparation = trackPreparation(async (params: Parameters<typeof prepare>[0]) => {
      preparedKeys.push(params.expected.sessionKey);
      if (params.expected.sessionKey === targets[0]!.sessionKey) {
        entered.resolve();
        await release.promise;
        throw new Error("synthetic exhausted-target read failure");
      }
      return await prepare(params);
    });
    vi.spyOn(recoveryTargets, "prepareExpectedRestartRecoveryCurrent").mockImplementation(
      preparation.run,
    );
    const warn = vi.spyOn(mainSessionRecoveryLog, "warn");
    const recovery = schedule({ maxRetries: 1 }, () => release.resolve());
    await withinTest(entered.promise, signal);
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    release.resolve();
    await gatewayRuntime.expectFailedRecovery(4, recovery, signal, targets[1]!);
    expect(preparation.peak).toBe(1);
    expect(preparedKeys).toEqual(targets.map(({ sessionKey }) => sessionKey));
    expect(loadSessionEntry(targets[0]!)).toMatchObject({
      status: "interrupted",
      mainRestartRecovery: { chargedAttempts: 3 },
    });
    expect(loadSessionEntry(targets[1]!)?.mainRestartRecovery?.tombstone).toBeDefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("synthetic exhausted-target read failure"),
    );
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it("stops exhaustion reconciliation while its Gateway admission is suspended", async () => {
    const { storePath } = await finalAttempt("cycle-suspended-exhaustion");
    const suspension = { lease: null as ReturnType<typeof tryBeginGatewaySuspendAdmission> };
    vi.mocked(callGateway)
      .mockImplementationOnce(async () => {
        suspension.lease = tryBeginGatewaySuspendAdmission(() => {});
        throw new Error("final ambiguous dispatch failure");
      })
      .mockResolvedValueOnce({ runId: "run-resumed" });
    const warn = vi.spyOn(mainSessionRecoveryLog, "warn");
    const reconciliationEntered = createDeferred();
    observeAdmission(
      () => {},
      (origin) => {
        if (origin === "main-session:target-recovery") {
          reconciliationEntered.resolve();
        }
      },
    );
    const recovery = schedule({ maxRetries: 1 }, () => {
      suspension.lease?.rollback();
    });
    await reconciliationEntered.promise;
    expect(suspension.lease).not.toBeNull();
    expect(callGateway).toHaveBeenCalledTimes(2);
    expect(getActiveGatewayRootWorkCount()).toBe(0);
    // Stop must settle while admission remains closed, not after reopening it.
    await recovery.stop();
    expect(suspension.lease?.rollback()).toBe(true);
    expect(callGateway).toHaveBeenCalledTimes(2);
    expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toMatchObject({
      status: "interrupted",
      abortedLastRun: true,
      mainRestartRecovery: { chargedAttempts: 3 },
    });
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining("main-session exhaustion reconciliation failed"),
    );
  });
});
