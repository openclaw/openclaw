import { describe, expect, it, vi } from "vitest";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useSubagentRestartRecoveryFixture } from "./subagent-restart-recovery.test-support.js";
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
