import { expect, it } from "vitest";
import type { GatewayRecoveryRuntime } from "../../../gateway/server-instance-runtime.types.js";
import { createSubagentSweeperHarness as createHarness } from "./subagent-registry-sweeper.test-support.js";

export function registerSweeperDeleteCleanupTests({
  killSessionEntry,
}: {
  killSessionEntry: {
    current: { sessionId: string; lifecycleRevision?: string; updatedAt: number } | undefined;
  };
}) {
  it("archives a retired recovery row without deleting its newer child session", async () => {
    const { entry, runs, callGateway, notifyContextEngineSubagentEnded, sweeper } = createHarness({
      current: {} as GatewayRecoveryRuntime,
    });
    entry.cleanup = "delete";
    entry.archiveAtMs = Date.now() - 1;
    entry.execution = {
      status: "terminal",
      startedAt: Date.now() - 60_000,
      endedAt: Date.now() - 55_000,
      outcome: { status: "error", error: "retired Gateway lifecycle" },
      suppressSessionEffects: true,
    };
    entry.endedReason = "subagent-error";

    await sweeper.sweepOnce();

    expect(callGateway).not.toHaveBeenCalled();
    expect(notifyContextEngineSubagentEnded).not.toHaveBeenCalled();
    expect(runs.has(entry.runId)).toBe(false);
  });

  it("does not delete a live successor when a dispatched delete row expires", async () => {
    const { entry, runs, callGateway, notifyContextEngineSubagentEnded, sweeper } = createHarness({
      current: {} as GatewayRecoveryRuntime,
    });
    const now = Date.now();
    entry.cleanup = "delete";
    entry.archiveAtMs = now - 1;
    entry.deleteCleanupDispatchedAt = now - 10_000;
    entry.deleteCleanupTarget = {
      sessionId: "original-session",
      lifecycleRevision: "original-revision",
    };
    entry.cleanupCompletedAt = now - 5_000;
    entry.execution = {
      status: "terminal",
      startedAt: now - 60_000,
      endedAt: now - 55_000,
      outcome: { status: "ok" },
    };
    killSessionEntry.current = {
      sessionId: "successor-session",
      lifecycleRevision: "successor-revision",
      updatedAt: now,
    };

    await sweeper.sweepOnce();

    expect(callGateway).not.toHaveBeenCalled();
    expect(notifyContextEngineSubagentEnded).not.toHaveBeenCalled();
    expect(runs.has(entry.runId)).toBe(false);
  });

  it("archives a fenced give-up row without deleting its same-key successor", async () => {
    const { entry, runs, callGateway, notifyContextEngineSubagentEnded, sweeper } = createHarness({
      current: {} as GatewayRecoveryRuntime,
    });
    const now = Date.now();
    entry.cleanup = "delete";
    entry.archiveAtMs = now - 1;
    entry.cleanupCompletedAt = now - 5_000;
    entry.execution = {
      status: "terminal",
      startedAt: now - 60_000,
      endedAt: now - 55_000,
      outcome: { status: "timeout" },
      suppressSessionEffects: true,
    };
    killSessionEntry.current = {
      sessionId: "successor-session",
      lifecycleRevision: "successor-revision",
      updatedAt: now,
    };

    await sweeper.sweepOnce();

    expect(callGateway).not.toHaveBeenCalled();
    expect(notifyContextEngineSubagentEnded).not.toHaveBeenCalled();
    expect(runs.has(entry.runId)).toBe(false);
  });

  it("retries an unfinished dispatched delete against its persisted identity at expiry", async () => {
    const { entry, runs, callGateway, notifyContextEngineSubagentEnded, sweeper } = createHarness({
      current: {} as GatewayRecoveryRuntime,
    });
    const now = Date.now();
    entry.cleanup = "delete";
    entry.archiveAtMs = now - 1;
    entry.deleteCleanupDispatchedAt = now - 10_000;
    entry.deleteCleanupTarget = {
      sessionId: "original-session",
      lifecycleRevision: "original-revision",
    };
    entry.cleanupCompletedAt = undefined;
    entry.execution = {
      status: "terminal",
      startedAt: now - 60_000,
      endedAt: now - 55_000,
      outcome: { status: "ok" },
    };

    await sweeper.sweepOnce();

    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "sessions.delete",
        params: expect.objectContaining({
          expectedSessionId: "original-session",
          expectedLifecycleRevision: "original-revision",
        }),
      }),
    );
    expect(notifyContextEngineSubagentEnded).toHaveBeenCalledWith({
      agentDir: undefined,
      childSessionKey: entry.childSessionKey,
      reason: "swept",
      workspaceDir: undefined,
    });
    expect(runs.has(entry.runId)).toBe(false);
  });

  it("retains an unfinished dispatched delete when the expiry retry fails", async () => {
    const { entry, runs, callGateway, notifyContextEngineSubagentEnded, sweeper, warn } =
      createHarness({ current: {} as GatewayRecoveryRuntime });
    const now = Date.now();
    entry.cleanup = "delete";
    entry.archiveAtMs = now - 1;
    entry.deleteCleanupDispatchedAt = now - 10_000;
    entry.deleteCleanupTarget = {
      sessionId: "original-session",
      lifecycleRevision: "original-revision",
    };
    entry.execution = {
      status: "terminal",
      startedAt: now - 60_000,
      endedAt: now - 55_000,
      outcome: { status: "ok" },
    };
    const failure = new Error("gateway unavailable");
    callGateway.mockRejectedValueOnce(failure);

    await sweeper.sweepOnce();

    expect(runs.get(entry.runId)).toBe(entry);
    expect(notifyContextEngineSubagentEnded).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "sessions.delete failed during subagent sweep; keeping run for retry",
      expect.objectContaining({ runId: entry.runId, error: failure }),
    );
  });
}
