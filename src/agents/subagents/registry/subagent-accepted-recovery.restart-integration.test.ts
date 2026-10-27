import { describe, expect, it, vi } from "vitest";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useSubagentRestartRecoveryFixture } from "./subagent-restart-recovery.test-support.js";
import { patchSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import { getAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import { runSubagentAnnounceFlow } from "../announce/subagent-announce.js";
import {
  createRecoverySessions,
  restartRegistry,
} from "./subagent-orphan-recovery.raw-owner.test-support.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import { prepareSubagentRecoveryFixture } from "./subagent-registry.persistence.test-support.js";
import { addSubagentRunForTests, testing } from "./subagent-registry.test-helpers.js";

describe("accepted subagent restart recovery", () => {
  const fixture = useSubagentRestartRecoveryFixture({ reuseDatabaseWorkers: true });
  const { childFixture } = createRecoverySessions(fixture);

  it.each(["interrupted", "terminal"] as const)(
    "records a failed worker placement from %s once across two registry restarts",
    async (status) => {
      const child = childFixture("failed-placement");
      const now = Date.now();
      const reason = "Worker setup failed. Repair the provider error, then restart the worker.";
      const storePath = await child.write({ abortedLastRun: true, updatedAt: now });
      await patchSessionEntryCore({ storePath, sessionKey: child.childSessionKey }, (entry) => ({
        ...entry,
        status: "interrupted",
        lifecycleRunId: child.runId,
        lastRunId: child.runId,
      }));
      const record = child.run({
        ...(status === "terminal"
          ? {
              terminalOwner: "interrupted-recovery" as const,
              endedReason: "subagent-error" as const,
            }
          : {}),
        execution: {
          ...(status === "terminal"
            ? { status, endedAt: now, outcome: { status: "error" as const, error: reason } }
            : { status, interruptionReason: "gateway-restart" as const }),
          startedAt: now - 1_000,
          lifecycleGeneration: getAgentEventLifecycleGeneration(),
        },
      });
      await prepareSubagentRecoveryFixture(record, { stateDir: fixture.stateDir });
      await addSubagentRunForTests(record);
      const release = vi.fn();
      const preparePlacement = vi
        .spyOn(fixture.gatewayRuntime, "prepareFailedWorkerPlacement")
        .mockReset()
        .mockResolvedValue({ reason, isCurrent: () => true, release });

      await fixture.settle();
      await restartRegistry(fixture);
      await testing.sweepOnceForTests();
      await fixture.settle();
      const settled = loadSubagentRegistryFromSqlite().get(child.runId);
      expect(settled).toMatchObject({
        execution: { status: "terminal", outcome: { status: "error", error: reason } },
      });
      expect(child.read()).toMatchObject({ status: "failed", lastRunError: reason });
      expect(child.read()?.abortedLastRun).toBeUndefined();
      expect(preparePlacement).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();

      await restartRegistry(fixture);
      await testing.sweepOnceForTests();
      await fixture.settle();
      expect(loadSubagentRegistryFromSqlite().get(child.runId)?.execution).toEqual(
        settled?.execution,
      );
      expect(preparePlacement).toHaveBeenCalledOnce();
      expect(fixture.dispatchAgent).not.toHaveBeenCalled();
    },
  );

  it("settles an accepted child without a lifecycle run at boot and promptly notifies its requester", async () => {
    const child = childFixture("accepted-before-crash");
    const startedAt = Date.now();
    await child.write({ updatedAt: startedAt, abortedLastRun: false });
    const entry = child.run({
      createdAt: startedAt,
      execution: {
        status: "running",
        startedAt,
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
      },
      expectsCompletionMessage: true,
    });
    await prepareSubagentRecoveryFixture(entry, { stateDir: fixture.stateDir });
    await addSubagentRunForTests(entry);
    await fixture.settle();
    vi.mocked(runSubagentAnnounceFlow).mockResolvedValue("delivered");
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const recoveryStartedAt = Date.now();
    try {
      await restartRegistry(fixture);
      await vi.advanceTimersByTimeAsync(1_000);
      await fixture.settle();

      expect(loadSubagentRegistryFromSqlite().get(child.runId)).toMatchObject({
        terminalOwner: "interrupted-recovery",
        execution: {
          status: "terminal",
          interruptionReason: "gateway-restart",
          outcome: { status: "error", error: expect.stringContaining("Gateway restart") },
        },
      });
      expect(child.read()).toMatchObject({ status: "interrupted", abortedLastRun: true });
      expect(runSubagentAnnounceFlow).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          childRunId: child.runId,
          requesterSessionKey: entry.requesterSessionKey,
          outcome: expect.objectContaining({
            status: "error",
            error: expect.stringContaining("Gateway restart"),
          }),
        }),
      );
      expect(Date.now() - recoveryStartedAt).toBeLessThan(2_000);
      expect(fixture.dispatchAgent).not.toHaveBeenCalled();
      await testing.sweepOnceForTests();
      await fixture.settle();
      expect(runSubagentAnnounceFlow).toHaveBeenCalledOnce();
      expect(loadSubagentRegistryFromSqlite().get(child.runId)?.execution.interruptionReason).toBe(
        "gateway-restart",
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
