// Terminal recovery preserves live execution and delivery ownership.
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { replaceSessionEntry } from "../../../config/sessions/session-accessor.js";
import { rotateAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import {
  claimAgentRunContext,
  clearAgentRunContext,
  getAgentRunContext,
  registerAgentRunContext,
  releaseAgentRunContext,
} from "../../../infra/agent-run-registry.js";
import { runSubagentAnnounceFlow } from "../announce/subagent-announce.js";
import {
  createRecoverySessions,
  restartRegistry,
} from "./subagent-orphan-recovery.raw-owner.test-support.js";
import { SubagentLifecycleController } from "./subagent-registry-lifecycle.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
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

export function registerRecoveredTerminalTests(
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

  const { childFixture } = createRecoverySessions(fixture);
  const readPersisted = (runId: string) => loadSubagentRegistryFromSqlite().get(runId);

  it("settles a completed child behind retained routing metadata without stealing live execution", async () => {
    const child = childFixture("completed-mirror");
    const startedAt = Date.now() - 3 * 60 * 1_000;
    const endedAt = startedAt + 60 * 1_000;
    await replaceSessionEntry(
      { agentId: "main", sessionKey: child.childSessionKey },
      {
        sessionId: child.sessionId,
        lifecycleRevision: "completed-mirror-revision",
        status: "done",
        startedAt,
        endedAt,
        updatedAt: endedAt,
        abortedLastRun: false,
        lastRunId: "image_generate:fixture:ok:agent-loop",
        activeWriterRunId: "image_generate:fixture:ok:agent-loop",
      },
    );
    const entry = child.run({
      createdAt: startedAt,
      startedAt,
      expectsCompletionMessage: true,
      runTimeoutSeconds: 3_600,
      completion: {
        required: true,
        terminalReply: { disposition: "visible", text: "Completed mirrored child result." },
      },
    });
    await prepareSubagentRecoveryFixture(entry, { stateDir: fixture.stateDir });
    await addSubagentRunForTests(entry);

    // Admission can borrow existing routing metadata without owning its lifetime.
    const context = { sessionKey: child.childSessionKey, sessionId: child.sessionId };
    registerAgentRunContext(child.runId, context);
    const claim = claimAgentRunContext(child.runId, context, {
      trackOwner: true,
      ownsContext: false,
    });
    try {
      await testing.sweepOnceForTests();
      expect(readPersisted(child.runId)?.execution.endedAt).toBeUndefined();
      expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();

      releaseAgentRunContext(child.runId, claim);
      expect(getAgentRunContext(child.runId)).toBeDefined();
      await testing.sweepOnceForTests();
      await fixture.settle();

      const completed = readPersisted(child.runId);
      expect(completed?.execution).toMatchObject({
        status: "terminal",
        endedAt,
        outcome: { status: "ok" },
      });
      expect(completed?.delivery?.status).toBe("delivered");
      expect(vi.mocked(runSubagentAnnounceFlow)).toHaveBeenCalledTimes(1);

      clearAgentRunContext(child.runId);
      await restartRegistry(fixture);
      await testing.sweepOnceForTests();
      await fixture.settle();
      const restored = readPersisted(child.runId);
      expect(restored?.execution).toMatchObject({
        status: "terminal",
        endedAt,
        outcome: { status: "ok" },
      });
      expect(restored?.delivery?.status).toBe("delivered");
      expect(runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    } finally {
      releaseAgentRunContext(child.runId, claim);
      clearAgentRunContext(child.runId);
    }
  });
}
