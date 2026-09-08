import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerContinuationDispatchClaim } from "../../auto-reply/continuation/continuation-dispatch-claims.js";
import { decodeWorkState } from "../../auto-reply/continuation/work-flow-state.js";
import { enqueuePendingWork } from "../../auto-reply/continuation/work-store.test-support.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import { clearSessionStoreCacheForTest } from "../../config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetSystemEventsForTest } from "../../infra/system-events.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import {
  finishFlow,
  getTaskFlowById,
  listTaskFlowsForOwnerKey,
  requestFlowCancel,
  updateFlowRecordByIdExpectedRevision,
} from "../../tasks/task-flow-registry.js";
import type { TaskFlowRecord } from "../../tasks/task-flow-registry.types.js";
import type { EmbeddedAgentRunResult } from "../embedded-agent.js";
import { scheduleSpawnInitContinueWorkWake } from "./attempt-execution.continue-work.js";

const taskFlowRuntimeState = vi.hoisted(() => ({
  beforeFailFlow: undefined as ((flowId: string) => void) | undefined,
  beforeAtomicCreate: undefined as (() => void) | undefined,
  beforeAtomicUpdate: undefined as (() => void) | undefined,
  beforeRequestFlowCancel: undefined as ((flowId: string) => void) | undefined,
  atomicCreateCalls: 0,
  failAtomicCreateCall: undefined as number | undefined,
  failAtomicUpdate: false,
}));
const sessionAccessorState = vi.hoisted(() => ({
  afterPatchCall: undefined as ((call: number) => void | Promise<void>) | undefined,
  failPatchCall: undefined as number | undefined,
  patchCalls: 0,
}));

vi.mock("../../tasks/task-flow-runtime-internal.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../tasks/task-flow-runtime-internal.js")>();
  return {
    ...actual,
    failFlow: (params: Parameters<typeof actual.failFlow>[0]) => {
      taskFlowRuntimeState.beforeFailFlow?.(params.flowId);
      return actual.failFlow(params);
    },
    createManagedTaskFlowWithAtomicUpdates: (
      params: Parameters<typeof actual.createManagedTaskFlowWithAtomicUpdates>[0],
    ) => {
      taskFlowRuntimeState.atomicCreateCalls += 1;
      taskFlowRuntimeState.beforeAtomicCreate?.();
      if (taskFlowRuntimeState.atomicCreateCalls === taskFlowRuntimeState.failAtomicCreateCall) {
        return { applied: false, reason: "persist_failed" as const };
      }
      return actual.createManagedTaskFlowWithAtomicUpdates(params);
    },
    updateTaskFlowsAtomically: (params: Parameters<typeof actual.updateTaskFlowsAtomically>[0]) => {
      taskFlowRuntimeState.beforeAtomicUpdate?.();
      if (taskFlowRuntimeState.failAtomicUpdate) {
        return { applied: false, reason: "persist_failed" as const };
      }
      return actual.updateTaskFlowsAtomically(params);
    },
    requestFlowCancel: (params: Parameters<typeof actual.requestFlowCancel>[0]) => {
      taskFlowRuntimeState.beforeRequestFlowCancel?.(params.flowId);
      return actual.requestFlowCancel(params);
    },
  };
});

vi.mock("../../config/sessions/session-accessor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/sessions/session-accessor.js")>();
  return {
    ...actual,
    patchSessionEntryCore: async (
      ...args: Parameters<typeof actual.patchSessionEntryCore>
    ): ReturnType<typeof actual.patchSessionEntryCore> => {
      sessionAccessorState.patchCalls += 1;
      if (sessionAccessorState.patchCalls === sessionAccessorState.failPatchCall) {
        throw new Error("synthetic continuation persistence failure");
      }
      const result = await actual.patchSessionEntryCore(...args);
      await sessionAccessorState.afterPatchCall?.(sessionAccessorState.patchCalls);
      return result;
    },
  };
});

function makeConfig(maxPendingWork = 8): OpenClawConfig {
  return {
    agents: {
      defaults: {
        continuation: {
          enabled: true,
          maxChainLength: 200,
          defaultDelayMs: 15_000,
          minDelayMs: 5_000,
          maxDelayMs: 86_400_000,
          costCapTokens: 50_000_000,
          maxDelegatesPerTurn: 500,
          maxPendingWork,
        },
      },
    },
  } as unknown as OpenClawConfig;
}

function makeRunResult(): EmbeddedAgentRunResult {
  return {
    payloads: [{ text: "ok" }],
    meta: {
      durationMs: 1,
      finalAssistantVisibleText: "ok",
      agentMeta: {
        sessionId: "session-embedded",
        provider: "anthropic",
        model: "claude-sonnet-4.7",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          total: 2,
        },
      },
    },
  };
}

function findFlowByReason(
  flows: readonly TaskFlowRecord[],
  reason: string,
): TaskFlowRecord | undefined {
  return flows.find((flow) => decodeWorkState(flow)?.reason === reason);
}

describe("spawn-init continuation cancellation races", () => {
  let tmpDir: string;
  let sessionEntry: SessionEntry;
  let sessionStore: Record<string, SessionEntry>;
  let storePath: string;
  let sessionKey: string;

  beforeEach(async () => {
    const { resetContinuationWorkDispatchForTests } =
      await import("../../auto-reply/continuation/work-dispatch.js");
    const { resetTaskFlowRegistryForTests } =
      await import("../../tasks/task-runtime.test-helpers.js");
    resetContinuationWorkDispatchForTests();
    resetTaskFlowRegistryForTests({ persist: false });
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-spawn-init-races-"));
    storePath = path.join(tmpDir, "sessions.json");
    sessionEntry = {
      sessionId: "session-embedded",
      updatedAt: Date.now(),
    } as SessionEntry;
    sessionKey = `agent:main:subagent:spawn-init-races:${crypto.randomUUID()}`;
    sessionStore = { [sessionKey]: sessionEntry };
    replaceSessionEntrySync({ storePath, sessionKey }, sessionEntry);
    clearSessionStoreCacheForTest();
    taskFlowRuntimeState.beforeFailFlow = undefined;
    taskFlowRuntimeState.beforeAtomicCreate = undefined;
    taskFlowRuntimeState.beforeAtomicUpdate = undefined;
    taskFlowRuntimeState.beforeRequestFlowCancel = undefined;
    taskFlowRuntimeState.atomicCreateCalls = 0;
    taskFlowRuntimeState.failAtomicCreateCall = undefined;
    taskFlowRuntimeState.failAtomicUpdate = false;
    sessionAccessorState.afterPatchCall = undefined;
    sessionAccessorState.failPatchCall = undefined;
    sessionAccessorState.patchCalls = 0;
    setRuntimeConfigSnapshot(makeConfig());
  });

  afterEach(async () => {
    const { resetContinuationWorkDispatchForTests } =
      await import("../../auto-reply/continuation/work-dispatch.js");
    const { resetTaskFlowRegistryForTests } =
      await import("../../tasks/task-runtime.test-helpers.js");
    resetContinuationWorkDispatchForTests();
    resetTaskFlowRegistryForTests({ persist: false });
    resetSystemEventsForTest();
    clearRuntimeConfigSnapshot();
    clearSessionStoreCacheForTest();
    closeOpenClawAgentDatabasesForTest();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function schedule(
    requests: Array<{ reason: string; delaySeconds: number }>,
    options: { abortSignal?: AbortSignal; maxPendingWork?: number } = {},
  ): Promise<void> {
    const cfg = makeConfig(options.maxPendingWork);
    setRuntimeConfigSnapshot(cfg);
    await scheduleSpawnInitContinueWorkWake({
      sessionKey,
      sessionEntry,
      sessionStore,
      storePath,
      requests,
      cfg,
      runResult: makeRunResult(),
      originRunId: "run-spawn-init-races",
      originTurnId: "session-embedded",
      abortSignal: options.abortSignal,
    });
  }

  async function enqueuePriorParkedWork(reason: string): Promise<void> {
    const now = Date.now();
    const work = enqueuePendingWork({
      sessionKey,
      hop: 1,
      delayMs: 30_000,
      electedAt: now,
      dueAt: now + 60_000,
      maxChainLength: 200,
      chainStartedAt: now,
      accumulatedChainTokens: 2,
      reason,
      anchorPending: true,
      idleRetry: {
        trigger: "reply-run-ended",
        reasonCategory: "follow-up-work",
        armedAt: now,
      },
    });
    expect(work).not.toBeNull();
  }

  function expectRestoredChainState(): void {
    expect(sessionStore[sessionKey]).toMatchObject({
      continuationChainCount: 0,
      continuationChainTokens: 0,
    });
  }

  it("rolls back the finalized partial-batch reservation when cancellation wins", async () => {
    const abort = new AbortController();
    sessionAccessorState.afterPatchCall = (call) => {
      if (call === 2) {
        abort.abort("test cancellation after partial finalization");
      }
    };

    await schedule(
      [
        { reason: "scheduled first election", delaySeconds: 30 },
        { reason: "pending-capped second election", delaySeconds: 30 },
      ],
      { abortSignal: abort.signal, maxPendingWork: 1 },
    );

    const flows = listTaskFlowsForOwnerKey(sessionKey);
    expect(flows).toHaveLength(1);
    expect(flows[0]).toMatchObject({ status: "failed" });
    expectRestoredChainState();
  });

  it("aborts an already-running wake before cancellation terminalizes it", async () => {
    const abort = new AbortController();
    let wakeSignal: AbortSignal | undefined;
    let releaseClaim = () => {};
    sessionAccessorState.afterPatchCall = (call) => {
      if (call !== 2) {
        return;
      }
      const created = findFlowByReason(
        listTaskFlowsForOwnerKey(sessionKey),
        "zero-delay running wake",
      );
      if (!created) {
        throw new Error("expected created continuation flow");
      }
      const running = updateFlowRecordByIdExpectedRevision({
        flowId: created.flowId,
        expectedRevision: created.revision,
        patch: { status: "running" },
      });
      if (!running.applied) {
        throw new Error("expected continuation flow to enter running state");
      }
      const claim = registerContinuationDispatchClaim({
        sessionKey,
        flowId: created.flowId,
      });
      wakeSignal = claim.controller.signal;
      releaseClaim = claim.release;
      abort.abort("test cancellation while replacement wake is running");
    };

    await schedule([{ reason: "zero-delay running wake", delaySeconds: 0 }], {
      abortSignal: abort.signal,
    });

    const postCancelSideEffects = wakeSignal?.aborted ? 0 : 1;
    releaseClaim();
    expect(wakeSignal?.aborted).toBe(true);
    expect(postCancelSideEffects).toBe(0);
    expect(listTaskFlowsForOwnerKey(sessionKey)).toEqual([
      expect.objectContaining({ status: "failed" }),
    ]);
  });

  it("aborts a wake that becomes running during cancellation cleanup", async () => {
    const abort = new AbortController();
    let wakeSignal: AbortSignal | undefined;
    let releaseClaim = () => {};
    taskFlowRuntimeState.beforeFailFlow = (flowId) => {
      taskFlowRuntimeState.beforeFailFlow = undefined;
      const queued = getTaskFlowById(flowId);
      if (!queued) {
        throw new Error("expected queued continuation flow");
      }
      const running = updateFlowRecordByIdExpectedRevision({
        flowId,
        expectedRevision: queued.revision,
        patch: { status: "running" },
      });
      if (!running.applied) {
        throw new Error("expected continuation flow to enter running state");
      }
      const claim = registerContinuationDispatchClaim({ sessionKey, flowId });
      wakeSignal = claim.controller.signal;
      releaseClaim = claim.release;
    };
    sessionAccessorState.afterPatchCall = (call) => {
      if (call === 2) {
        abort.abort("test cancellation during cleanup claim race");
      }
    };

    await schedule([{ reason: "cleanup-racing wake", delaySeconds: 30 }], {
      abortSignal: abort.signal,
    });

    const postCancelSideEffects = wakeSignal?.aborted ? 0 : 1;
    releaseClaim();
    expect(wakeSignal?.aborted).toBe(true);
    expect(postCancelSideEffects).toBe(0);
    expect(listTaskFlowsForOwnerKey(sessionKey)).toEqual([
      expect.objectContaining({ status: "failed" }),
    ]);
  });

  it("continues multi-wake cleanup and rolls back after one terminalization throws", async () => {
    const abort = new AbortController();
    sessionAccessorState.afterPatchCall = (call) => {
      if (call === 2) {
        abort.abort("test cancellation before multi-wake cleanup");
      }
    };
    taskFlowRuntimeState.beforeFailFlow = () => {
      taskFlowRuntimeState.beforeFailFlow = undefined;
      throw new Error("synthetic first-flow cleanup failure");
    };

    await schedule(
      [
        { reason: "first replacement wake", delaySeconds: 30 },
        { reason: "second replacement wake", delaySeconds: 30 },
      ],
      { abortSignal: abort.signal },
    );

    expect(listTaskFlowsForOwnerKey(sessionKey)).toEqual([
      expect.objectContaining({ status: "failed" }),
      expect.objectContaining({ status: "failed" }),
    ]);
    expectRestoredChainState();
  });

  it("replaces a parked wake at the pending cap and preserves the replacement across reload", async () => {
    await enqueuePriorParkedWork("prior parked work");
    let reloadedFlows: TaskFlowRecord[] = [];
    sessionAccessorState.afterPatchCall = async (call) => {
      if (call !== 2) {
        return;
      }
      const { resetTaskFlowRegistryForTests } =
        await import("../../tasks/task-runtime.test-helpers.js");
      resetTaskFlowRegistryForTests({ persist: false });
      reloadedFlows = listTaskFlowsForOwnerKey(sessionKey);
    };

    await schedule([{ reason: "replacement work", delaySeconds: 30 }], { maxPendingWork: 1 });

    expect(reloadedFlows.filter((flow) => flow.status === "queued")).toEqual([
      expect.objectContaining({
        stateJson: expect.objectContaining({ reason: "replacement work" }),
      }),
    ]);
    expect(findFlowByReason(reloadedFlows, "prior parked work")).toMatchObject({
      status: "succeeded",
    });
  });

  it("retries around a concurrently cancelled prior wake without reviving it", async () => {
    await enqueuePriorParkedWork("prior parked work");
    taskFlowRuntimeState.beforeAtomicCreate = () => {
      taskFlowRuntimeState.beforeAtomicCreate = undefined;
      const prior = findFlowByReason(listTaskFlowsForOwnerKey(sessionKey), "prior parked work");
      if (!prior) {
        throw new Error("expected prior parked flow");
      }
      const cancelled = requestFlowCancel({
        flowId: prior.flowId,
        expectedRevision: prior.revision,
        cancelRequestedAt: Date.now(),
      });
      expect(cancelled.applied).toBe(true);
    };

    await schedule([{ reason: "replacement work", delaySeconds: 30 }]);

    const flows = listTaskFlowsForOwnerKey(sessionKey);
    expect(findFlowByReason(flows, "prior parked work")).toMatchObject({
      status: "queued",
      cancelRequestedAt: expect.any(Number),
    });
    expect(findFlowByReason(flows, "replacement work")).toMatchObject({ status: "queued" });
    expect(sessionStore[sessionKey]?.continuationChainCount).toBe(1);
  });

  it("retries the whole replacement transition when one prior CAS advances", async () => {
    await enqueuePriorParkedWork("first prior parked work");
    await enqueuePriorParkedWork("second prior parked work");
    taskFlowRuntimeState.beforeAtomicCreate = () => {
      taskFlowRuntimeState.beforeAtomicCreate = undefined;
      const prior = findFlowByReason(
        listTaskFlowsForOwnerKey(sessionKey),
        "second prior parked work",
      );
      if (!prior) {
        throw new Error("expected second prior parked flow");
      }
      const bumped = updateFlowRecordByIdExpectedRevision({
        flowId: prior.flowId,
        expectedRevision: prior.revision,
        patch: { currentStep: "concurrent second prior-wake update" },
      });
      expect(bumped.applied).toBe(true);
    };

    await schedule([{ reason: "replacement work", delaySeconds: 30 }]);

    const flows = listTaskFlowsForOwnerKey(sessionKey);
    expect(findFlowByReason(flows, "first prior parked work")).toMatchObject({
      status: "succeeded",
    });
    expect(findFlowByReason(flows, "second prior parked work")).toMatchObject({
      status: "succeeded",
    });
    expect(findFlowByReason(flows, "replacement work")).toMatchObject({ status: "queued" });
    expect(sessionStore[sessionKey]?.continuationChainCount).toBe(1);
  });

  it("fails closed when a parked owner starts running before replacement admission", async () => {
    await enqueuePriorParkedWork("prior parked work");
    taskFlowRuntimeState.beforeAtomicCreate = () => {
      taskFlowRuntimeState.beforeAtomicCreate = undefined;
      const prior = findFlowByReason(listTaskFlowsForOwnerKey(sessionKey), "prior parked work");
      if (!prior) {
        throw new Error("expected prior parked flow");
      }
      const running = updateFlowRecordByIdExpectedRevision({
        flowId: prior.flowId,
        expectedRevision: prior.revision,
        patch: { status: "running" },
      });
      expect(running.applied).toBe(true);
    };

    await expect(
      schedule([{ reason: "rejected replacement work", delaySeconds: 30 }]),
    ).rejects.toThrow("running_owner");

    const flows = listTaskFlowsForOwnerKey(sessionKey);
    expect(findFlowByReason(flows, "prior parked work")).toMatchObject({ status: "running" });
    expect(findFlowByReason(flows, "rejected replacement work")).toBeUndefined();
    expectRestoredChainState();
  });

  it("allows a stable running predecessor while replacing a distinct parked wake", async () => {
    await enqueuePriorParkedWork("prior parked work");
    const now = Date.now();
    const predecessor = enqueuePendingWork({
      sessionKey,
      hop: 1,
      delayMs: 0,
      electedAt: now,
      dueAt: now,
      maxChainLength: 200,
      chainStartedAt: now,
      accumulatedChainTokens: 0,
      reason: "stable running predecessor",
      anchorFinalizedAt: now,
    });
    if (!predecessor?.flowId || predecessor.expectedRevision === undefined) {
      throw new Error("expected running predecessor flow");
    }
    const running = updateFlowRecordByIdExpectedRevision({
      flowId: predecessor.flowId,
      expectedRevision: predecessor.expectedRevision,
      patch: { status: "running" },
    });
    expect(running.applied).toBe(true);

    await schedule([{ reason: "replacement work", delaySeconds: 30 }]);

    const flows = listTaskFlowsForOwnerKey(sessionKey);
    expect(findFlowByReason(flows, "stable running predecessor")).toMatchObject({
      status: "running",
    });
    expect(findFlowByReason(flows, "prior parked work")).toMatchObject({ status: "succeeded" });
    expect(findFlowByReason(flows, "replacement work")).toMatchObject({ status: "queued" });
  });

  it("supersedes a newer parked owner discovered after the first replacement CAS loses", async () => {
    await enqueuePriorParkedWork("original prior parked work");
    taskFlowRuntimeState.beforeAtomicCreate = () => {
      taskFlowRuntimeState.beforeAtomicCreate = undefined;
      const original = findFlowByReason(
        listTaskFlowsForOwnerKey(sessionKey),
        "original prior parked work",
      );
      if (!original) {
        throw new Error("expected original prior parked flow");
      }
      const superseded = finishFlow({
        flowId: original.flowId,
        expectedRevision: original.revision,
        currentStep: "superseded by concurrent replacement",
      });
      expect(superseded.applied).toBe(true);
      const now = Date.now();
      expect(
        enqueuePendingWork({
          sessionKey,
          hop: 2,
          delayMs: 30_000,
          electedAt: now,
          dueAt: now + 60_000,
          maxChainLength: 200,
          chainStartedAt: now,
          accumulatedChainTokens: 2,
          reason: "concurrent newer parked work",
          anchorPending: true,
          idleRetry: {
            trigger: "reply-run-ended",
            reasonCategory: "follow-up-work",
            armedAt: now,
          },
        }),
      ).not.toBeNull();
    };

    await schedule([{ reason: "newest replacement work", delaySeconds: 30 }]);

    const { resetTaskFlowRegistryForTests } =
      await import("../../tasks/task-runtime.test-helpers.js");
    resetTaskFlowRegistryForTests({ persist: false });
    const flows = listTaskFlowsForOwnerKey(sessionKey);
    expect(findFlowByReason(flows, "original prior parked work")).toMatchObject({
      status: "succeeded",
    });
    expect(findFlowByReason(flows, "concurrent newer parked work")).toMatchObject({
      status: "succeeded",
    });
    expect(flows.filter((flow) => flow.status === "queued")).toEqual([
      expect.objectContaining({
        stateJson: expect.objectContaining({ reason: "newest replacement work" }),
      }),
    ]);
  });

  it("restores a newer parked owner discovered by retry when finalization fails", async () => {
    await enqueuePriorParkedWork("original prior parked work");
    sessionAccessorState.failPatchCall = 2;
    taskFlowRuntimeState.beforeAtomicCreate = () => {
      taskFlowRuntimeState.beforeAtomicCreate = undefined;
      const original = findFlowByReason(
        listTaskFlowsForOwnerKey(sessionKey),
        "original prior parked work",
      );
      if (!original) {
        throw new Error("expected original prior parked flow");
      }
      const superseded = finishFlow({
        flowId: original.flowId,
        expectedRevision: original.revision,
        currentStep: "superseded by concurrent replacement",
      });
      expect(superseded.applied).toBe(true);
      const now = Date.now();
      expect(
        enqueuePendingWork({
          sessionKey,
          hop: 2,
          delayMs: 30_000,
          electedAt: now,
          dueAt: now + 60_000,
          maxChainLength: 200,
          chainStartedAt: now,
          accumulatedChainTokens: 2,
          reason: "concurrent newer parked work",
          anchorPending: true,
          idleRetry: {
            trigger: "reply-run-ended",
            reasonCategory: "follow-up-work",
            armedAt: now,
          },
        }),
      ).not.toBeNull();
    };

    await expect(
      schedule([{ reason: "newest replacement work", delaySeconds: 30 }]),
    ).rejects.toThrow();

    const { resetTaskFlowRegistryForTests } =
      await import("../../tasks/task-runtime.test-helpers.js");
    resetTaskFlowRegistryForTests({ persist: false });
    const flows = listTaskFlowsForOwnerKey(sessionKey);
    expect(findFlowByReason(flows, "original prior parked work")).toMatchObject({
      status: "succeeded",
    });
    expect(findFlowByReason(flows, "concurrent newer parked work")).toMatchObject({
      status: "queued",
    });
    expect(findFlowByReason(flows, "newest replacement work")).toMatchObject({
      status: "failed",
    });
  });

  it("does not restore a stale original when retry superseded an exact empty owner set", async () => {
    await enqueuePriorParkedWork("original prior parked work");
    sessionAccessorState.failPatchCall = 2;
    taskFlowRuntimeState.beforeAtomicCreate = () => {
      taskFlowRuntimeState.beforeAtomicCreate = undefined;
      const original = findFlowByReason(
        listTaskFlowsForOwnerKey(sessionKey),
        "original prior parked work",
      );
      if (!original) {
        throw new Error("expected original prior parked flow");
      }
      const finished = finishFlow({
        flowId: original.flowId,
        expectedRevision: original.revision,
        currentStep: "completed independently before retry",
      });
      expect(finished.applied).toBe(true);
    };

    await expect(
      schedule([{ reason: "replacement after empty refresh", delaySeconds: 30 }]),
    ).rejects.toThrow();

    const { resetTaskFlowRegistryForTests } =
      await import("../../tasks/task-runtime.test-helpers.js");
    resetTaskFlowRegistryForTests({ persist: false });
    const flows = listTaskFlowsForOwnerKey(sessionKey);
    expect(findFlowByReason(flows, "original prior parked work")).toMatchObject({
      status: "succeeded",
      currentStep: "completed independently before retry",
    });
    expect(findFlowByReason(flows, "replacement after empty refresh")).toMatchObject({
      status: "failed",
    });
  });

  it("still cancels the replacement when partial prior-wake restoration loses its revision", async () => {
    await enqueuePriorParkedWork("first prior parked work");
    await enqueuePriorParkedWork("second prior parked work");
    sessionAccessorState.failPatchCall = 2;
    taskFlowRuntimeState.beforeAtomicUpdate = () => {
      taskFlowRuntimeState.beforeAtomicUpdate = undefined;
      const prior = findFlowByReason(
        listTaskFlowsForOwnerKey(sessionKey),
        "second prior parked work",
      );
      if (!prior) {
        throw new Error("expected second prior parked flow");
      }
      const bumped = updateFlowRecordByIdExpectedRevision({
        flowId: prior.flowId,
        expectedRevision: prior.revision,
        patch: { currentStep: "concurrent second prior-wake update" },
      });
      expect(bumped.applied).toBe(true);
    };

    await expect(schedule([{ reason: "replacement work", delaySeconds: 30 }])).rejects.toThrow();

    const flows = listTaskFlowsForOwnerKey(sessionKey);
    expect(findFlowByReason(flows, "first prior parked work")).toMatchObject({
      status: "queued",
    });
    expect(findFlowByReason(flows, "second prior parked work")).toMatchObject({
      status: "succeeded",
    });
    expect(findFlowByReason(flows, "replacement work")).toMatchObject({ status: "failed" });
    expect(sessionStore[sessionKey]?.continuationChainCount).toBe(1);
  });

  it("does not credit a concurrently requeued prior with changed rollback state", async () => {
    await enqueuePriorParkedWork("prior parked work");
    sessionAccessorState.failPatchCall = 2;
    taskFlowRuntimeState.beforeAtomicUpdate = () => {
      taskFlowRuntimeState.beforeAtomicUpdate = undefined;
      const prior = findFlowByReason(listTaskFlowsForOwnerKey(sessionKey), "prior parked work");
      if (!prior) {
        throw new Error("expected superseded prior flow");
      }
      const requeued = updateFlowRecordByIdExpectedRevision({
        flowId: prior.flowId,
        expectedRevision: prior.revision,
        patch: {
          status: "queued",
          currentStep: "concurrently requeued with different state",
        },
      });
      expect(requeued.applied).toBe(true);
    };

    await expect(schedule([{ reason: "replacement work", delaySeconds: 30 }])).rejects.toThrow(
      "spawn-init chain finalization and wake cleanup both failed",
    );

    const flows = listTaskFlowsForOwnerKey(sessionKey);
    expect(findFlowByReason(flows, "prior parked work")).toMatchObject({
      status: "queued",
      currentStep: "concurrently requeued with different state",
    });
    expect(findFlowByReason(flows, "replacement work")).toMatchObject({ status: "failed" });
    expect(sessionStore[sessionKey]?.continuationChainCount).toBe(1);
  });

  it("aborts a replacement that starts running during atomic rollback", async () => {
    await enqueuePriorParkedWork("prior parked work");
    sessionAccessorState.failPatchCall = 2;
    let wakeSignal: AbortSignal | undefined;
    let releaseClaim = () => {};
    taskFlowRuntimeState.beforeAtomicUpdate = () => {
      taskFlowRuntimeState.beforeAtomicUpdate = undefined;
      const replacement = findFlowByReason(
        listTaskFlowsForOwnerKey(sessionKey),
        "replacement work",
      );
      if (!replacement) {
        throw new Error("expected replacement flow");
      }
      const running = updateFlowRecordByIdExpectedRevision({
        flowId: replacement.flowId,
        expectedRevision: replacement.revision,
        patch: { status: "running" },
      });
      if (!running.applied) {
        throw new Error("expected replacement flow to enter running state");
      }
      const claim = registerContinuationDispatchClaim({
        sessionKey,
        flowId: replacement.flowId,
      });
      wakeSignal = claim.controller.signal;
      releaseClaim = claim.release;
    };
    taskFlowRuntimeState.beforeRequestFlowCancel = (flowId) => {
      taskFlowRuntimeState.beforeRequestFlowCancel = undefined;
      const running = getTaskFlowById(flowId);
      if (!running) {
        throw new Error("expected running replacement before cancellation");
      }
      const bumped = updateFlowRecordByIdExpectedRevision({
        flowId,
        expectedRevision: running.revision,
        patch: { currentStep: "concurrent running cancellation revision" },
      });
      expect(bumped.applied).toBe(true);
    };

    await expect(schedule([{ reason: "replacement work", delaySeconds: 30 }])).rejects.toThrow();

    releaseClaim();
    const flows = listTaskFlowsForOwnerKey(sessionKey);
    expect(wakeSignal?.aborted).toBe(true);
    expect(findFlowByReason(flows, "prior parked work")).toMatchObject({ status: "succeeded" });
    expect(findFlowByReason(flows, "replacement work")).toMatchObject({
      status: "running",
      cancelRequestedAt: expect.any(Number),
    });
  });

  it("atomically rolls back every replacement in a partial batch and survives reload", async () => {
    await enqueuePriorParkedWork("prior parked work");
    sessionAccessorState.failPatchCall = 2;

    await expect(
      schedule([
        { reason: "first replacement work", delaySeconds: 30 },
        { reason: "second replacement work", delaySeconds: 30 },
      ]),
    ).rejects.toThrow();

    const { resetTaskFlowRegistryForTests } =
      await import("../../tasks/task-runtime.test-helpers.js");
    resetTaskFlowRegistryForTests({ persist: false });
    const flows = listTaskFlowsForOwnerKey(sessionKey);
    expect(findFlowByReason(flows, "prior parked work")).toMatchObject({ status: "queued" });
    expect(findFlowByReason(flows, "first replacement work")).toMatchObject({ status: "failed" });
    expect(findFlowByReason(flows, "second replacement work")).toMatchObject({ status: "failed" });
  });

  it("rolls back earlier durable work when a later batch enqueue fails", async () => {
    await enqueuePriorParkedWork("prior parked work");
    taskFlowRuntimeState.failAtomicCreateCall = 2;

    await expect(
      schedule([
        { reason: "first replacement work", delaySeconds: 30 },
        { reason: "failed second replacement work", delaySeconds: 30 },
      ]),
    ).rejects.toThrow("prior parked-wake supersession did not commit");

    const { resetTaskFlowRegistryForTests } =
      await import("../../tasks/task-runtime.test-helpers.js");
    resetTaskFlowRegistryForTests({ persist: false });
    const flows = listTaskFlowsForOwnerKey(sessionKey);
    expect(findFlowByReason(flows, "prior parked work")).toMatchObject({ status: "queued" });
    expect(findFlowByReason(flows, "first replacement work")).toMatchObject({ status: "failed" });
    expect(findFlowByReason(flows, "failed second replacement work")).toBeUndefined();
    expectRestoredChainState();
  });

  it("cleans up safe siblings without restoring prior work after one replacement succeeded", async () => {
    await enqueuePriorParkedWork("prior parked work");
    sessionAccessorState.failPatchCall = 2;
    taskFlowRuntimeState.beforeAtomicUpdate = () => {
      taskFlowRuntimeState.beforeAtomicUpdate = undefined;
      const replacement = findFlowByReason(
        listTaskFlowsForOwnerKey(sessionKey),
        "second replacement work",
      );
      if (!replacement) {
        throw new Error("expected replacement flow");
      }
      const finished = finishFlow({
        flowId: replacement.flowId,
        expectedRevision: replacement.revision,
        currentStep: "replacement already delivered",
      });
      expect(finished.applied).toBe(true);
    };

    await expect(
      schedule([
        { reason: "first replacement work", delaySeconds: 30 },
        { reason: "second replacement work", delaySeconds: 30 },
      ]),
    ).rejects.toThrow();

    const { resetTaskFlowRegistryForTests } =
      await import("../../tasks/task-runtime.test-helpers.js");
    resetTaskFlowRegistryForTests({ persist: false });
    const flows = listTaskFlowsForOwnerKey(sessionKey);
    expect(findFlowByReason(flows, "prior parked work")).toMatchObject({ status: "succeeded" });
    expect(findFlowByReason(flows, "first replacement work")).toMatchObject({ status: "failed" });
    expect(findFlowByReason(flows, "second replacement work")).toMatchObject({
      status: "succeeded",
    });
  });

  it("aborts and cancel-marks a queued replacement that starts running during fallback", async () => {
    await enqueuePriorParkedWork("first prior parked work");
    await enqueuePriorParkedWork("second prior parked work");
    sessionAccessorState.failPatchCall = 2;
    taskFlowRuntimeState.failAtomicUpdate = true;
    let wakeSignal: AbortSignal | undefined;
    let releaseClaim = () => {};
    taskFlowRuntimeState.beforeRequestFlowCancel = (flowId) => {
      taskFlowRuntimeState.beforeRequestFlowCancel = undefined;
      const flow = getTaskFlowById(flowId);
      if (!flow) {
        throw new Error("expected queued replacement before cancellation");
      }
      const bumped = updateFlowRecordByIdExpectedRevision({
        flowId,
        expectedRevision: flow.revision,
        patch: { status: "running", currentStep: "concurrent cancellation revision" },
      });
      expect(bumped.applied).toBe(true);
      const claim = registerContinuationDispatchClaim({ sessionKey, flowId });
      wakeSignal = claim.controller.signal;
      releaseClaim = claim.release;
    };

    await expect(schedule([{ reason: "replacement work", delaySeconds: 30 }])).rejects.toThrow();

    releaseClaim();
    const flows = listTaskFlowsForOwnerKey(sessionKey);
    expect(wakeSignal?.aborted).toBe(true);
    expect(findFlowByReason(flows, "first prior parked work")).toMatchObject({
      status: "succeeded",
    });
    expect(findFlowByReason(flows, "second prior parked work")).toMatchObject({
      status: "succeeded",
    });
    expect(findFlowByReason(flows, "replacement work")).toMatchObject({
      status: "running",
      cancelRequestedAt: expect.any(Number),
    });
    expect(sessionStore[sessionKey]?.continuationChainCount).toBe(1);
  });

  it("marks an unresolved running replacement cancelled when atomic rollback keeps failing", async () => {
    await enqueuePriorParkedWork("prior parked work");
    sessionAccessorState.failPatchCall = 2;
    taskFlowRuntimeState.failAtomicUpdate = true;
    taskFlowRuntimeState.beforeAtomicUpdate = () => {
      taskFlowRuntimeState.beforeAtomicUpdate = undefined;
      const replacement = findFlowByReason(
        listTaskFlowsForOwnerKey(sessionKey),
        "replacement work",
      );
      if (!replacement) {
        throw new Error("expected replacement flow");
      }
      const running = updateFlowRecordByIdExpectedRevision({
        flowId: replacement.flowId,
        expectedRevision: replacement.revision,
        patch: { status: "running" },
      });
      expect(running.applied).toBe(true);
    };

    await expect(schedule([{ reason: "replacement work", delaySeconds: 30 }])).rejects.toThrow();

    expect(
      findFlowByReason(listTaskFlowsForOwnerKey(sessionKey), "replacement work"),
    ).toMatchObject({
      status: "running",
      cancelRequestedAt: expect.any(Number),
    });
  });
});
