import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { InternalSessionEntry } from "../../config/sessions.js";
import {
  appendTranscriptMessage,
  loadSessionEntry as loadSessionEntryRaw,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { callGateway } from "../../gateway/call.js";
import { resetAgentEventsForTest } from "../../infra/agent-events.js";
import * as gatewayWorkAdmission from "../../process/gateway-work-admission.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../../process/gateway-work-admission.js";
import {
  getSessionWorkAdmissionOwnerRelease,
  interruptSessionWorkAdmissions,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { waitForFast } from "../subagent-test-fixtures.test-helpers.js";
import { MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER } from "./main-session-recovery-admission.js";
import { createMainSessionRecoveryCapacity } from "./main-session-recovery-capacity.js";
import { createRecoveryRuntimeFixture } from "./main-session-recovery-runtime.test-support.js";
import { mainSessionRecoveryLog } from "./main-session-restart-recovery-shared.js";
import {
  recoverRestartAbortedMainSessions as recoverRestartAbortedMainSessionsBase,
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

const recoverRestartAbortedMainSessions = (
  params: Omit<Parameters<typeof recoverRestartAbortedMainSessionsBase>[0], "gatewayRuntime">,
) => recoverRestartAbortedMainSessionsBase({ ...params, gatewayRuntime });

function gatewayParams() {
  return vi.mocked(callGateway).mock.calls[0]?.[0].params;
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

  async function makeMainSessionFixture(overrides: Partial<InternalSessionEntry> = {}) {
    const sessionKey = "agent:main:main";
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
    const storePath = path.join(sessionsDir, "sessions.json");
    await fs.mkdir(sessionsDir, { recursive: true });
    await replaceSessionEntry(
      { sessionKey, storePath },
      {
        sessionId: "main-session",
        permissionMode: "guarded",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
        ...overrides,
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
    const mutation = runExclusiveSessionLifecycleMutation({
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

  it.each(["resume", "interrupt"] as const)(
    "owns startup recovery while waiting for capacity and releases on %s",
    async (action) => {
      const { sessionsDir, storePath, sessionKey } = await makeMainSessionFixture();
      await writeCompletedToolTranscript(sessionsDir);
      const capacity = createMainSessionRecoveryCapacity({ limit: 1 });
      const releaseCapacity = await capacity.acquire(() => true);
      let keepRunning = true;
      const recovery = recoverRestartAbortedMainSessions({
        stateDir: tmpDir,
        recoveryCapacity: capacity,
        shouldContinue: () => keepRunning,
      });
      try {
        await waitForFast(() =>
          expect(
            loadSessionEntry({ sessionKey, storePath })?.mainRestartRecovery?.reservation,
          ).toBeDefined(),
        );
        const ownerReleased = getSessionWorkAdmissionOwnerRelease({
          scope: storePath,
          identities: [sessionKey, "main-session"],
          owner: MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER,
        });
        expect(ownerReleased).toBeDefined();
        expect(callGateway).not.toHaveBeenCalled();

        if (action === "interrupt") {
          await expect(
            interruptSessionWorkAdmissions({
              scope: storePath,
              identities: [sessionKey, "main-session"],
            }),
          ).resolves.toBe(true);
          await expect(recovery).resolves.toMatchObject({ started: 0, failed: 0, skipped: 1 });
          expect(callGateway).not.toHaveBeenCalled();
          expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
            abortedLastRun: true,
            mainRestartRecovery: { chargedAttempts: 0 },
          });
          expect(
            loadSessionEntry({ sessionKey, storePath })?.mainRestartRecovery?.reservation,
          ).toBeUndefined();
        } else {
          releaseCapacity?.();
          await expect(recovery).resolves.toMatchObject({ started: 1, failed: 0 });
          expect(callGateway).toHaveBeenCalledOnce();
          expect(gatewayParams()).toMatchObject({ internalRuntimeHandoffId: expect.any(String) });
          expect(loadSessionEntry({ sessionKey, storePath })?.abortedLastRun).toBe(false);
        }
        await ownerReleased;
        expect(
          getSessionWorkAdmissionOwnerRelease({
            scope: storePath,
            identities: [sessionKey, "main-session"],
            owner: MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER,
          }),
        ).toBeUndefined();
      } finally {
        keepRunning = false;
        releaseCapacity?.();
        dispatchSettlement.resolve();
        await recovery;
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
        status: "running",
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
