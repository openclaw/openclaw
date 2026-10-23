// Restart recovery replay against a recovered row whose cleanup is still live in-process.
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { rotateAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import { runSubagentAnnounceFlow } from "../announce/subagent-announce.js";
import { SubagentLifecycleController } from "./subagent-registry-lifecycle.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import {
  prepareSubagentRecoveryFixture,
  writeSubagentSessionEntry,
} from "./subagent-registry.persistence.test-support.js";
import {
  addSubagentRunForTests,
  initSubagentRegistry,
  resetSubagentRegistryForTests,
  testing,
} from "./subagent-registry.test-helpers.js";
import {
  makeRestartRecoveryRun as makeRunRecord,
  type useSubagentRestartRecoveryFixture,
} from "./subagent-restart-recovery.test-support.js";

export function registerRecoveredTerminalTailTest(
  fixture: ReturnType<typeof useSubagentRestartRecoveryFixture>,
) {
  const { activateGatewayRuntime } = fixture;

  it("leaves a recovered terminal tail to its live cleanup when a sweep overlaps delivery", async () => {
    const runId = "draining-recovered-tail";
    const childSessionKey = "agent:main:subagent:draining-recovered-tail";
    const sessionId = "draining-recovered-tail-session";
    const lifecycleRevision = "draining-recovered-tail-revision";
    await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: childSessionKey,
      defaultSessionId: sessionId,
      lifecycleRevision,
      abortedLastRun: true,
    });
    const recovered = makeRunRecord({
      runId,
      childSessionKey,
      childSessionIdentity: { sessionId, lifecycleRevision },
      expectsCompletionMessage: true,
      execution: { status: "interrupted", startedAt: Date.now() - 1_000 },
    });
    await prepareSubagentRecoveryFixture(recovered, { stateDir: fixture.stateDir });
    await addSubagentRunForTests(recovered);
    const announcing = createDeferred();
    const delivered = createDeferred<"delivered">();
    const announce = vi.mocked(runSubagentAnnounceFlow).mockImplementation(async () => {
      announcing.resolve();
      return await delivered.promise;
    });
    await fixture.settle();
    await resetSubagentRegistryForTests({ persist: false });
    rotateAgentEventLifecycleGeneration();
    // Background sweeper ticks can overlap the explicit sweep; count every terminal entry.
    const lock = vi.spyOn(SubagentLifecycleController.prototype, "acquireTerminalCompletionLock");
    try {
      await initSubagentRegistry();
      await activateGatewayRuntime();
      await announcing.promise;
      expect(subagentRuns.get(runId)).toMatchObject({
        terminalOwner: "interrupted-recovery",
        execution: { status: "terminal" },
      });
      await testing.sweepOnceForTests();
      // Only activation's recovery completes the row; its cleanup owns the delivering tail.
      expect(lock.mock.calls.filter(([id]) => id === runId)).toHaveLength(1);
    } finally {
      lock.mockRestore();
      delivered.resolve("delivered");
    }
    await fixture.settle();
    expect(announce).toHaveBeenCalledTimes(1);
    expect(subagentRuns.get(runId)?.cleanupCompletedAt).toEqual(expect.any(Number));
  });
}
