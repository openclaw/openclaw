import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { InternalSessionEntry } from "../../config/sessions.js";
import {
  appendTranscriptMessage,
  loadSessionEntry as loadSessionEntryRaw,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { callGateway } from "../../gateway/call.js";
import * as transcriptReaders from "../../gateway/session-transcript-readers.js";
import { resetAgentEventsForTest } from "../../infra/agent-events.js";
import * as gatewayWorkAdmission from "../../process/gateway-work-admission.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../../process/gateway-work-admission.js";
import {
  getSessionWorkAdmissionOwnerRelease,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { waitForFast } from "../subagent-test-fixtures.test-helpers.js";
import { MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER } from "./main-session-recovery-admission.js";
import { createRecoveryRuntimeFixture } from "./main-session-recovery-runtime.test-support.js";
import { mainSessionRecoveryLog } from "./main-session-restart-recovery-shared.js";
import {
  retryRestartAbortedMainSessionRecovery,
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

function loadSessionEntry(scope: Parameters<typeof loadSessionEntryRaw>[0]) {
  return loadSessionEntryRaw(scope) as InternalSessionEntry | undefined;
}

function makePendingFinalDelivery(): InternalSessionEntry["pendingFinalDelivery"] {
  return {
    kind: "replayable",
    text: "interrupted response",
    createdAt: Date.now(),
    intentId: "intent-prepared-default",
    deliveries: [{ id: "delivery-prepared-default", state: "prepared" }],
  };
}

describe("startup recovery admission", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(callGateway).mockReset().mockResolvedValue({ runId: "run-resumed" });
    dispatchSettlement = createDeferred();
    resetAgentEventsForTest();
    resetGatewayWorkAdmission();
    tmpDir = tempDirs.make("openclaw-recovery-admission-");
  });

  afterEach(async () => {
    resetGatewayWorkAdmission();
    await cleanupSessionStateForTest({ stateDir: tmpDir });
  });

  async function makeMainSessionFixture(
    overrides: Partial<InternalSessionEntry> & { agentId?: string; sessionKey?: string } = {},
  ) {
    const { agentId = "main", sessionKey = "agent:main:main", ...entry } = overrides;
    const sessionsDir = path.join(tmpDir, "agents", agentId, "sessions");
    const storePath = path.join(sessionsDir, "sessions.json");
    await fs.mkdir(sessionsDir, { recursive: true });
    await replaceSessionEntry(
      { sessionKey, storePath },
      {
        sessionId: "main-session",
        permissionMode: "guarded",
        updatedAt: Date.now() - 10_000,
        status: "interrupted",
        abortedLastRun: true,
        mainRestartRecovery: { cycleId: "interrupted-cycle", revision: 1, chargedAttempts: 0 },
        ...entry,
      },
    );
    return { sessionsDir, storePath, sessionKey };
  }

  async function writeCompletedToolTranscript(sessionsDir: string) {
    for (const message of [
      { role: "user", content: "run the tool" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "exec" }] },
      { role: "toolResult", content: "done" },
    ]) {
      await appendTranscriptMessage(
        {
          sessionId: "main-session",
          sessionKey: "agent:main:main",
          storePath: path.join(sessionsDir, "sessions.json"),
        },
        { message, cwd: sessionsDir },
      );
    }
  }

  it("skips a recovery target replaced while its admission waits", async () => {
    const { storePath, sessionKey } = await makeMainSessionFixture();
    const mutationEntered = createDeferred();
    const releaseMutation = createDeferred();
    const mutation = runExclusiveSessionLifecycleMutation("recover", {
      scope: storePath,
      identities: [sessionKey, "main-session"],
      run: async () => {
        mutationEntered.resolve();
        await releaseMutation.promise;
        await replaceSessionEntry(
          { storePath, sessionKey },
          { sessionId: "replacement-session", updatedAt: Date.now(), status: "done" },
        );
      },
    });
    await mutationEntered.promise;
    const recovery = retryRestartAbortedMainSessionRecovery({
      expectedSessionId: "main-session",
      storePath,
      sessionKey,
      gatewayRuntime,
    });
    try {
      await waitForFast(() =>
        expect(
          getSessionWorkAdmissionOwnerRelease({
            scope: storePath,
            identities: [sessionKey, "main-session"],
            owner: MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER,
          }),
        ).toBeDefined(),
      );
      releaseMutation.resolve();
      await mutation;
      await expect(recovery).resolves.toEqual({ started: 0, settled: 0, failed: 0, skipped: 1 });
      expect(callGateway).not.toHaveBeenCalled();
      expect(loadSessionEntry({ storePath, sessionKey })).toMatchObject({
        sessionId: "replacement-session",
        status: "done",
      });
    } finally {
      releaseMutation.resolve();
      await Promise.allSettled([mutation, recovery]);
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
      let preparing = 0;
      let peakPreparation = 0;
      const readSpy = vi
        .spyOn(transcriptReaders, "readSessionMessagesAsync")
        .mockImplementation(async (...args) => {
          preparing++;
          peakPreparation = Math.max(peakPreparation, preparing);
          try {
            if (args[0].sessionId === "main-session") {
              prepared.resolve();
              await releasePreparation.promise;
            }
            return await read(...args);
          } finally {
            preparing--;
          }
        });
      const passFinished = createDeferred();
      const admit = gatewayWorkAdmission.runWithGatewayIndependentRootWorkAdmission;
      const admissionSpy = vi
        .spyOn(gatewayWorkAdmission, "runWithGatewayIndependentRootWorkAdmission")
        .mockImplementation(
          async <T>(run: () => Promise<T>, origin?: string, abort?: AbortSignal) => {
            try {
              return await admit(run, origin, abort);
            } finally {
              if (origin === "main-session:startup-recovery") {
                passFinished.resolve();
              }
            }
          },
        );
      const recovery = scheduleRestartAbortedMainSessionRecovery({
        getConfig: () => ({ agents: { entries: { main: {}, other: {} } } }),
        delayMs: 0,
        stateDir: tmpDir,
        gatewayRuntime,
      });
      try {
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
        expect(peakPreparation).toBe(1);
        expect(callGateway).toHaveBeenCalledTimes(action === "stop" ? 0 : 2);
        expect(getActiveGatewayRootWorkCount()).toBe(0);
        for (const scope of [first, second]) {
          expect(loadSessionEntry(scope)?.status).toBe(
            action === "stop" ? "interrupted" : undefined,
          );
          expect(loadSessionEntry(scope)?.abortedLastRun).toBe(action === "stop");
        }
        if (action === "continue") {
          expect(waitSpy).not.toHaveBeenCalled();
          const lines = info.mock.calls.map(([line]) => line);
          expect(lines).toContainEqual(
            expect.stringMatching(
              /startup complete: started=2 .*skipReasons=.*not_main_session:1.*work_start_blocked:1/,
            ),
          );
          const decisions = lines
            .filter((line) => line.startsWith("main-session restart recovery candidate "))
            .map((line) =>
              JSON.parse(line.slice("main-session restart recovery candidate ".length)),
            );
          expect(decisions).toHaveLength(3);
          expect(decisions).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                sessionKey: first.sessionKey,
                sourceRunId: "interrupted-main",
                decision: "started",
                nextOwner: "main-lane",
                boot: expect.any(String),
                pass: expect.any(String),
              }),
              expect.objectContaining({
                sessionKey: "agent:main:archived",
                decision: "blocked",
                nextOwner: "operator",
              }),
            ]),
          );
        }
        if (action === "stop") {
          expect(loadSessionEntry(first)?.mainRestartRecovery).toMatchObject({
            chargedAttempts: 0,
          });
          expect(loadSessionEntry(first)?.mainRestartRecovery?.reservation).toBeUndefined();
        }
      } finally {
        releasePreparation.resolve();
        dispatchSettlement.resolve();
        await recovery.stop();
        readSpy.mockRestore();
        admissionSpy.mockRestore();
        waitSpy.mockRestore();
        info.mockRestore();
      }
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
    const admit = gatewayWorkAdmission.runWithGatewayIndependentRootWorkAdmission;
    let attempt = 0;
    const admissionSpy = vi
      .spyOn(gatewayWorkAdmission, "runWithGatewayIndependentRootWorkAdmission")
      .mockImplementation(
        async <T>(run: () => Promise<T>, origin?: string, signal?: AbortSignal) => {
          const settled = attempt++ === 0 ? firstAttempt : secondAttempt;
          try {
            return await admit(run, origin, signal);
          } finally {
            settled.resolve();
          }
        },
      );
    vi.useFakeTimers();
    const recovery = scheduleRestartAbortedMainSessionRecovery({
      getConfig: () => ({}),
      delayMs: 0,
      maxRetries: 2,
      stateDir: tmpDir,
      gatewayRuntime,
    });

    try {
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
    } finally {
      suspensionRef.current?.release();
      await recovery.stop();
      admissionSpy.mockRestore();
      vi.useRealTimers();
    }
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
        const fixture = await makeMainSessionFixture({
          agentId: directory,
          sessionKey,
          sessionId: multipleStores ? `ops-session-${index}` : "main-session",
          mainRestartRecovery: {
            cycleId: multipleStores ? `cycle-ops-${index}` : "cycle-final-startup-attempt",
            revision: 1,
            chargedAttempts: 2,
          },
          pendingFinalDelivery: makePendingFinalDelivery(),
        });
        targets.push({ agentId, sessionKey, storePath: fixture.storePath });
      }
      const { storePath } = targets[0]!;
      if (multipleStores) {
        vi.mocked(callGateway).mockImplementation(async ({ method }) => {
          if (method === "agent") {
            throw new Error("final ambiguous dispatch failure");
          }
          return { status: "timeout" };
        });
      } else {
        vi.mocked(callGateway)
          .mockImplementationOnce(async () => {
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
      const recovery = scheduleRestartAbortedMainSessionRecovery({
        getConfig: () => ({ agents: { entries: { [agentId]: {} } } }),
        delayMs: 0,
        maxRetries: 1,
        stateDir: tmpDir,
        gatewayRuntime,
      });
      await gatewayRuntime.expectFailedRecovery(2 * targets.length, recovery, signal, ...targets);
      for (const [index, target] of targets.entries()) {
        const entry = loadSessionEntry(target);
        expect(entry).toMatchObject({
          status: "failed",
          mainRestartRecovery: { tombstone: expect.any(Object) },
        });
        if (multipleStores) {
          expect(entry?.mainRestartRecovery?.chargedAttempts).toBe(3);
          expect(entry?.mainRestartRecovery?.reservation).toBeUndefined();
          expect(entry).toMatchObject({ sessionId: `ops-session-${index}`, abortedLastRun: false });
        }
      }
      if (multipleStores) {
        expect(
          vi.mocked(callGateway).mock.calls.filter(([call]) => call.method === "agent"),
        ).toHaveLength(2);
      } else {
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

  it("stops exhaustion reconciliation while its Gateway admission is suspended", async () => {
    const { storePath } = await makeMainSessionFixture({
      mainRestartRecovery: {
        cycleId: "cycle-suspended-exhaustion",
        revision: 1,
        chargedAttempts: 2,
      },
      pendingFinalDelivery: makePendingFinalDelivery(),
    });
    const suspension = { lease: null as ReturnType<typeof tryBeginGatewaySuspendAdmission> };
    vi.mocked(callGateway)
      .mockImplementationOnce(async () => {
        suspension.lease = tryBeginGatewaySuspendAdmission(() => {});
        throw new Error("final ambiguous dispatch failure");
      })
      .mockResolvedValueOnce({ runId: "run-resumed" });
    const warn = vi.spyOn(mainSessionRecoveryLog, "warn");
    const reconciliationEntered = createDeferred();
    const admit = gatewayWorkAdmission.runWithGatewayIndependentRootWorkAdmission;
    const admissionSpy = vi
      .spyOn(gatewayWorkAdmission, "runWithGatewayIndependentRootWorkAdmission")
      .mockImplementation(<T>(run: () => Promise<T>, origin?: string, signal?: AbortSignal) => {
        const admitted = admit(run, origin, signal);
        if (origin === "main-session:target-recovery") {
          reconciliationEntered.resolve();
        }
        return admitted;
      });
    const recovery = scheduleRestartAbortedMainSessionRecovery({
      getConfig: () => ({}),
      delayMs: 0,
      maxRetries: 1,
      stateDir: tmpDir,
      gatewayRuntime,
    });
    try {
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
    } finally {
      suspension.lease?.rollback();
      await recovery.stop();
      admissionSpy.mockRestore();
      warn.mockRestore();
    }
  });
});
