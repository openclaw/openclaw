import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../../../infra/agent-events.js";
import {
  clearAgentRunContext,
  registerAgentRunContext,
} from "../../../infra/agent-run-registry.js";
import { bindGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import { beginSessionWorkAdmission } from "../../../sessions/session-lifecycle-admission.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { restartRecoveryTestHarness } from "./subagent-registry-restart-recovery.test-support.js";
import { createSubagentSweeperHarness } from "./subagent-registry-sweeper.test-support.js";
import { buildRequesterSettleWakeIdentity } from "./subagent-requester-settle-identity.js";

const { mocks, childSessionKey, gatewayRuntime, dispatchAgent, run, recover } =
  restartRecoveryTestHarness;

describe("subagent registry restart recovery", () => {
  beforeEach(() => restartRecoveryTestHarness.reset());

  it("does not reread large sessions retained by unchanged live owners over five sweeps", async () => {
    const { sweeper, runs } = createSubagentSweeperHarness({ current: gatewayRuntime });
    runs.clear();
    const serialized = JSON.stringify({
      sessionId: "retained-session",
      lifecycleRevision: "retained-revision",
      status: "running",
      updatedAt: Date.now(),
      skillsSnapshot: { prompt: "x".repeat(1024 * 1024), skills: [] },
    });
    let bytes = 0;
    mocks.loadSessionEntry.mockImplementation(() => {
      bytes += Buffer.byteLength(serialized);
      return JSON.parse(serialized);
    });
    for (let index = 0; index < 30; index++) {
      const entry = run({
        runId: `retained-${index}`,
        childSessionKey: `agent:main:subagent:retained-${index}`,
      });
      entry.execution.lifecycleGeneration = getAgentEventLifecycleGeneration();
      runs.set(entry.runId, entry);
      registerAgentRunContext(`owner-${index}`, {
        sessionKey: entry.childSessionKey,
        sessionId: "retained-session",
      });
    }
    const ticks: Array<{ reads: number; bytes: number }> = [];
    const started = performance.now();
    try {
      for (let tick = 0; tick < 5; tick++) {
        mocks.loadSessionEntry.mockClear();
        bytes = 0;
        await sweeper.sweepOnce();
        ticks.push({ reads: mocks.loadSessionEntry.mock.calls.length, bytes });
      }
      console.info(
        "retained recovery fixture",
        JSON.stringify({
          ticks,
          elapsedMs: performance.now() - started,
          rss: process.memoryUsage().rss,
        }),
      );
      expect(ticks.slice(1)).toEqual(Array.from({ length: 4 }, () => ({ reads: 0, bytes: 0 })));
    } finally {
      for (let index = 0; index < 30; index++) {
        clearAgentRunContext(`owner-${index}`);
      }
      sweeper.reset();
    }
  });

  it.each(["run", "admission"] as const)(
    "recovers as soon as a retained %s releases ownership",
    async (owner) => {
      vi.useFakeTimers();
      const entry = run();
      entry.execution.status = "interrupted";
      const { sweeper, finalizeInterruptedSubagentRun } = createSubagentSweeperHarness(
        { current: gatewayRuntime },
        entry,
      );
      const lease =
        owner === "admission"
          ? await beginSessionWorkAdmission({
              scope: mocks.storePath,
              identities: [childSessionKey, "session-id"],
              assertAllowed: () => {},
            })
          : undefined;
      if (owner === "run") {
        registerAgentRunContext("retained-owner", {
          sessionKey: childSessionKey,
          sessionId: "session-id",
        });
      }
      try {
        await sweeper.sweepOnce();
        mocks.loadSessionEntry.mockClear();
        await sweeper.sweepOnce();
        expect(mocks.loadSessionEntry).not.toHaveBeenCalled();
        expect(finalizeInterruptedSubagentRun).not.toHaveBeenCalled();
        lease?.release();
        clearAgentRunContext("retained-owner");
        await vi.advanceTimersByTimeAsync(1_000);
        expect(mocks.loadSessionEntry).toHaveBeenCalled();
        expect(finalizeInterruptedSubagentRun).toHaveBeenCalledOnce();
      } finally {
        sweeper.reset();
        lease?.release();
        clearAgentRunContext("retained-owner");
        vi.useRealTimers();
      }
    },
  );

  it.each(["yield", "steer", "kill", "queued"] as const)(
    "abandons recovery when %s takes ownership during the session read",
    async (owner) => {
      const entry = run();
      mocks.loadSessionEntry.mockImplementationOnce(() => {
        if (owner === "yield") {
          entry.pauseReason = "sessions_yield";
        }
        if (owner === "steer") {
          entry.suppressAnnounceReason = "steer-restart";
        }
        if (owner === "kill") {
          entry.killIntent = { requestedAt: Date.now(), reason: "killed" };
        }
        if (owner === "queued") {
          entry.execution.status = "queued";
        }
        return mocks.entries[childSessionKey];
      });
      expect(await recover(entry)).toEqual({ status: "deferred" });
      expect(mocks.patchSessionEntryCore).not.toHaveBeenCalled();
      expect(dispatchAgent).not.toHaveBeenCalled();
    },
  );

  it("preserves an abort marker owned by a newer visible execution", async () => {
    mocks.entries[childSessionKey]!.lifecycleRunId = "newer-visible-run";

    expect(await recover(run())).toMatchObject({
      status: "terminal",
      suppressSessionEffects: true,
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
    expect(mocks.patchSessionEntryCore).not.toHaveBeenCalled();
    expect(mocks.entries[childSessionKey]).toMatchObject({
      lifecycleRunId: "newer-visible-run",
      abortedLastRun: true,
    });
  });

  describe("orphaned running sessions", () => {
    it.each([60_000, 3 * 24 * 60 * 60_000])(
      "reconciles a hard-kill orphan last observed %i ms ago",
      async (ageMs) => {
        const entry = run();
        const updatedAt = Date.now() - ageMs;
        entry.execution.lifecycleGeneration = getAgentEventLifecycleGeneration();
        Object.assign(mocks.entries[childSessionKey]!, {
          status: "running",
          lifecycleRunId: entry.runId,
          abortedLastRun: false,
          updatedAt,
        });
        rotateAgentEventLifecycleGeneration();

        expect(await recover(entry)).toMatchObject({
          status: "terminal",
          error: expect.stringContaining("Gateway restart"),
        });
        expect(mocks.entries[childSessionKey]?.updatedAt).toBe(updatedAt);
        expect(dispatchAgent).not.toHaveBeenCalled();
        expect(gatewayRuntime.sendRecoveryNotice).not.toHaveBeenCalled();
      },
    );

    it.each([
      "current lifecycle",
      "different run",
      "completed session",
      "completed session with stale abort marker",
    ])("does not invent a restart interruption for a %s", async (scenario) => {
      const entry = run();
      entry.execution.lifecycleGeneration = getAgentEventLifecycleGeneration();
      if (scenario !== "current lifecycle") {
        rotateAgentEventLifecycleGeneration();
      }
      Object.assign(mocks.entries[childSessionKey]!, {
        status: scenario.startsWith("completed session") ? "done" : "running",
        lifecycleRunId: scenario === "different run" ? "newer-run" : entry.runId,
        abortedLastRun: scenario === "completed session with stale abort marker",
      });
      expect(await recover(entry)).toEqual({ status: "ignored" });
      expect(dispatchAgent).not.toHaveBeenCalled();
      expect(mocks.patchSessionEntryCore).not.toHaveBeenCalled();
    });

    it.each([
      ["run", false],
      ["admission", false],
      ["run", true],
      ["admission", true],
    ] as const)(
      "does not mark a hard-kill orphan after a fresh %s owns its session (recovered=%s)",
      async (owner, recovered) => {
        const entry = run();
        if (recovered) {
          entry.taskRunId = "original-task-run";
          entry.execution.transcriptTarget = { sessionKey: "agent:main:internal:recovered" };
        }
        entry.execution.lifecycleGeneration = getAgentEventLifecycleGeneration();
        rotateAgentEventLifecycleGeneration();
        Object.assign(mocks.entries[childSessionKey]!, {
          status: "running",
          lifecycleRunId: recovered ? "steered-source" : entry.runId,
          abortedLastRun: false,
          subagentRecovery: recovered
            ? { lastRunId: entry.runId, sessionLifecycleRunId: "steered-source" }
            : undefined,
        });
        const lease =
          owner === "admission"
            ? await beginSessionWorkAdmission({
                scope: mocks.storePath,
                identities: [childSessionKey, "session-id"],
                assertAllowed: () => {},
              })
            : undefined;
        if (owner === "run") {
          registerAgentRunContext("fresh-owner", {
            sessionKey: childSessionKey,
            sessionId: "session-id",
          });
        }
        try {
          expect(await recover(entry)).toMatchObject({ status: "handled" });
          expect(mocks.entries[childSessionKey]?.abortedLastRun).toBe(false);
          expect(dispatchAgent).not.toHaveBeenCalled();
        } finally {
          lease?.release();
          clearAgentRunContext("fresh-owner");
        }
      },
    );

    it.each([
      "current lifecycle",
      "different task",
      "different recovery",
      "newer visible run",
      "missing transcript",
    ])("does not adopt a hidden recovery with %s", async (scenario) => {
      const entry = run({ taskRunId: "original-task-run" });
      entry.execution.lifecycleGeneration = getAgentEventLifecycleGeneration();
      entry.execution.transcriptTarget = { sessionKey: "agent:main:internal:recovered" };
      if (scenario !== "current lifecycle") {
        rotateAgentEventLifecycleGeneration();
      }
      Object.assign(mocks.entries[childSessionKey]!, {
        status: "running",
        lifecycleRunId: scenario === "newer visible run" ? "visible-run" : "original-task-run",
        abortedLastRun: false,
        subagentRecovery: {
          lastRunId: scenario === "different recovery" ? "older-recovery" : entry.runId,
          ...(scenario !== "different task" ? { sessionLifecycleRunId: "original-task-run" } : {}),
        },
      });
      if (scenario === "different task") {
        entry.taskRunId = "different-task-run";
      }
      if (scenario === "missing transcript") {
        entry.execution.transcriptTarget = undefined;
      }
      expect(await recover(entry)).toEqual({ status: "ignored" });
      expect(dispatchAgent).not.toHaveBeenCalled();
      expect(mocks.patchSessionEntryCore).not.toHaveBeenCalled();
    });

    it.each(["session", "visible turn"])(
      "keeps a replacement %s untouched when orphan marking waits for the store",
      async (replacementKind) => {
        const entry = run();
        if (replacementKind === "visible turn") {
          entry.taskRunId = "original-task-run";
          entry.execution.transcriptTarget = { sessionKey: "agent:main:internal:recovered" };
        }
        entry.execution.lifecycleGeneration = getAgentEventLifecycleGeneration();
        rotateAgentEventLifecycleGeneration();
        Object.assign(mocks.entries[childSessionKey]!, {
          status: "running",
          lifecycleRunId: replacementKind === "visible turn" ? "steered-source" : entry.runId,
          abortedLastRun: false,
          subagentRecovery: {
            lastRunId: entry.runId,
            sessionLifecycleRunId:
              replacementKind === "visible turn" ? "steered-source" : entry.runId,
          },
        });
        const replacementSessionId =
          replacementKind === "session" ? "replacement-session" : "session-id";
        mocks.patchSessionEntryCore.mockImplementationOnce(async (_scope, update) => {
          const replacement = {
            ...mocks.entries[childSessionKey]!,
            sessionId: replacementSessionId,
            lifecycleRunId: "replacement-run",
          };
          mocks.entries[childSessionKey] = replacement;
          return update({ ...replacement });
        });
        expect(await recover(entry)).toEqual({ status: "deferred" });
        expect(dispatchAgent).not.toHaveBeenCalled();
        expect(mocks.entries[childSessionKey]).toMatchObject({
          sessionId: replacementSessionId,
          lifecycleRunId: "replacement-run",
          abortedLastRun: false,
        });
      },
    );
  });

  it.each(["attempted", "consumed", "accepted", "abandoned"] as const)(
    "settles a persisted %s launch receipt without dispatch",
    async (phase) => {
      const entry = run();
      entry.execution.restartRecovery = {
        phase,
        sessionId: "session-id",
        sessionMarker: "session-id:1",
        idempotencyKey: "old-recovery-run",
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
      };
      rotateAgentEventLifecycleGeneration();
      expect(await recover(entry)).toMatchObject({
        status: "terminal",
        suppressSessionEffects: true,
      });
      expect(dispatchAgent).not.toHaveBeenCalled();
      expect(mocks.entries[childSessionKey]?.abortedLastRun).toBe(true);
    },
  );

  it.each(["sessions_yield", "steer-restart", "terminal", "queued", "non-aborted"])(
    "leaves %s ownership unchanged",
    async (owner) => {
      const entry = run();
      if (owner === "sessions_yield") {
        entry.pauseReason = "sessions_yield";
      }
      if (owner === "steer-restart") {
        entry.suppressAnnounceReason = "steer-restart";
      }
      if (owner === "terminal") {
        entry.execution = { status: "terminal", endedAt: Date.now(), outcome: { status: "ok" } };
      }
      if (owner === "queued") {
        entry.execution.status = "queued";
      }
      if (owner === "non-aborted") {
        mocks.entries[childSessionKey]!.abortedLastRun = false;
      }
      expect(await recover(entry)).toEqual({ status: "ignored" });
      expect(dispatchAgent).not.toHaveBeenCalled();
    },
  );
});

describe("interrupted requester-settle continuation ownership", () => {
  beforeEach(() => restartRecoveryTestHarness.reset());
  afterEach(() => subagentRuns.clear());

  function cohort() {
    const child = run({
      runId: "settled-leaf",
      childSessionKey: "agent:main:subagent:leaf",
      requesterSessionKey: childSessionKey,
      requesterAgentId: "main",
      requesterStorePath: "/tmp/openclaw-subagent-recovery/agents/main/agent/openclaw-agent.sqlite",
      completionRequesterSessionId: "session-id",
      expectsCompletionMessage: true,
      execution: { status: "terminal", endedAt: Date.now(), outcome: { status: "ok" } },
      requesterSettleWake: {
        status: "dispatching",
        attemptCount: 1,
        batchRunIds: ["settled-leaf"],
        requesterYieldBatch: true,
        rearmGeneration: 1,
      },
    });
    const { runId } = buildRequesterSettleWakeIdentity({
      requesterSessionKey: childSessionKey,
      requesterAgentId: "main",
      batchRunIds: [child.runId],
      rearmGeneration: 1,
    });
    const worker = run({ runId, taskRunId: "original-task" });
    worker.execution.status = "interrupted";
    worker.execution.interruptionReason = "gateway-restart";
    mocks.entries[childSessionKey]!.lifecycleRunId = runId;
    const context = { recoveryRuntime: gatewayRuntime } as GatewayRequestContext;
    let open = true;
    bindGatewayContextResolver(child, () => (open ? context : undefined));
    subagentRuns.set(worker.runId, worker);
    subagentRuns.set(child.runId, child);
    return {
      child,
      worker,
      close: () => {
        open = false;
      },
    };
  }

  it.each([
    { backoff: 0, privateCompletion: false, physicalLocator: false },
    { backoff: 0, privateCompletion: false, physicalLocator: true },
    { backoff: 120_000, privateCompletion: false, physicalLocator: false },
    { backoff: 120_000, privateCompletion: true, physicalLocator: false },
  ])(
    "keeps the exact saved wake owned before admission (backoff $backoff, private $privateCompletion, physical locator $physicalLocator)",
    async ({ backoff, privateCompletion, physicalLocator }) => {
      const { child, worker } = cohort();
      if (physicalLocator) {
        mocks.storePath = child.requesterStorePath!;
      }
      child.requesterSettleWake!.nextAttemptAt = Date.now() + backoff;
      if (privateCompletion) {
        child.completionTarget = "parent";
        child.requesterSettleWake!.attemptCount = 2;
      }
      expect(await recover(worker)).toEqual({ status: "handled" });
      expect(worker.execution.outcome).toBeUndefined();
      expect(dispatchAgent).not.toHaveBeenCalled();
      expect(mocks.patchSessionEntryCore).not.toHaveBeenCalled();
    },
  );

  it.each([
    "different attempt",
    "non-yield batch",
    "rearmed",
    "unstarted",
    "consumed",
    "missing member",
    "different session",
    "different agent",
    "different store",
    "replaced child",
    "closed gateway",
    "cancelled custody",
    "suppressed delivery",
    "legacy launch receipt",
  ])("retains ordinary interruption recovery for %s", async (scenario) => {
    const { child, worker, close } = cohort();
    if (scenario === "non-yield batch") {
      child.requesterSettleWake!.requesterYieldBatch = undefined;
    }
    if (scenario === "different attempt") {
      child.requesterSettleWake!.attemptCount++;
    }
    if (scenario === "rearmed") {
      child.requesterSettleWake!.rearmGeneration!++;
    }
    if (scenario === "unstarted") {
      child.requesterSettleWake!.attemptCount = 0;
    }
    if (scenario === "consumed") {
      child.requesterSettleWake = undefined;
    }
    if (scenario === "missing member") {
      child.requesterSettleWake!.batchRunIds!.push("missing");
    }
    if (scenario === "different session") {
      child.completionRequesterSessionId = "replacement";
    }
    if (scenario === "different agent") {
      child.requesterAgentId = "other";
    }
    if (scenario === "different store") {
      child.requesterStorePath = "/tmp/replacement.sqlite";
    }
    if (scenario === "replaced child") {
      subagentRuns.set("replacement-leaf", {
        ...child,
        runId: "replacement-leaf",
        generation: (child.generation ?? 1) + 1,
      });
    }
    if (scenario === "closed gateway") {
      close();
    }
    if (scenario === "cancelled custody") {
      child.killReconciliation = { killedAt: Date.now(), suppressTaskDelivery: true };
    }
    if (scenario === "suppressed delivery") {
      child.suppressCompletionDelivery = true;
    }
    if (scenario === "legacy launch receipt") {
      worker.execution.restartRecovery = {
        phase: "accepted",
        sessionId: "session-id",
        sessionMarker: "session-id:1",
        idempotencyKey: "old-launch",
      };
    }
    expect(await recover(worker)).toMatchObject({
      status: "terminal",
      error: expect.stringContaining("Gateway restart"),
    });
  });

  it("rechecks incoming custody before a classified interruption can commit", async () => {
    const { child, worker } = cohort();
    subagentRuns.delete(child.runId);
    const result = await recover(worker);
    expect(result.status).toBe("terminal");
    if (result.status !== "terminal") {
      throw new Error("missing interruption classification");
    }
    expect(result.isRecoveryCurrent?.()).toBe(true);
    subagentRuns.set(child.runId, child);
    expect(result.isRecoveryCurrent?.()).toBe(false);
  });
});
