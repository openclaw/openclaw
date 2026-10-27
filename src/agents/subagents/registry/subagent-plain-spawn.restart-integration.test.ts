import { describe, expect, it, vi } from "vitest";
// Preserve registry fixture setup before its consumers.
// oxfmt-ignore
import { makeRestartRecoveryRun, useSubagentRestartRecoveryFixture } from "./subagent-restart-recovery.test-support.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { persistGatewaySessionLifecycleEvent } from "../../../gateway/session-lifecycle-state.js";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../../../infra/agent-events.js";
import { cleanupSessionStateForTest } from "../../../test-utils/session-state-cleanup.js";
import { prepareCommandSessionRecoveryEntry } from "../../command/session-preparation.js";
import { runSubagentAnnounceFlow } from "../announce/subagent-announce.js";
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

describe("plain child spawn crash recovery", () => {
  const fixture = useSubagentRestartRecoveryFixture();

  it.each([false, true])(
    "settles the interrupted spawn once after a later turn (done=%s)",
    async (done) => {
      const runId = "plain-spawn-before-crash";
      const sessionKey = "agent:main:subagent:plain-spawn";
      const sessionId = "plain-spawn-session";
      const lifecycleRevision = "plain-spawn-revision";
      const startedAt = Date.now() - 60_000;
      const entry = makeRestartRecoveryRun({
        runId,
        childSessionKey: sessionKey,
        childAgentId: "main",
        childSessionIdentity: { sessionId, lifecycleRevision },
        requesterSessionKey: "agent:main:subagent:parent",
        expectsCompletionMessage: true,
        createdAt: startedAt,
        execution: {
          status: "running",
          startedAt,
          lifecycleGeneration: getAgentEventLifecycleGeneration(),
        },
      });
      await prepareSubagentRecoveryFixture(entry, { stateDir: fixture.stateDir });
      const storePath = await writeSubagentSessionEntry({
        stateDir: fixture.stateDir,
        agentId: "main",
        sessionKey,
        defaultSessionId: sessionId,
        lifecycleRevision,
      });
      const target = { agentId: "main", storePath, sessionKey };
      await replaceSessionEntry(
        target,
        prepareCommandSessionRecoveryEntry({
          entry: { ...loadSessionEntryReadOnly(target)!, spawnDepth: 2 },
          sessionId,
          sessionKey,
          agentId: "main",
          runId,
          now: startedAt,
          lifecycleGeneration: getAgentEventLifecycleGeneration(),
          isSessionRollover: false,
          opts: { message: "Run the child task." },
        }).nextEntry,
      );
      const lifecycle = async (id: string, phase: "start" | "end", ts: number) =>
        persistGatewaySessionLifecycleEvent({
          sessionKey,
          event: {
            runId: id,
            sessionId,
            lifecycleGeneration: getAgentEventLifecycleGeneration(),
            ts,
            data: { phase, startedAt: ts, ...(phase === "end" ? { endedAt: ts } : {}) },
          },
        });
      await lifecycle(runId, "start", startedAt);
      await addSubagentRunForTests(entry);
      await fixture.settle();
      await resetSubagentRegistryForTests({ persist: false });
      await cleanupSessionStateForTest({ stateDir: fixture.stateDir });
      rotateAgentEventLifecycleGeneration();

      // Another child's announcement can finish before the old spawn is reconciled.
      const laterRunId = "announce:v1:worker-completion";
      await lifecycle(laterRunId, "start", startedAt + 30_000);
      if (done) {
        await lifecycle(laterRunId, "end", startedAt + 31_000);
      }
      const laterSession = loadSessionEntryReadOnly(target);
      expect(laterSession?.status).toBe(done ? "done" : undefined);
      expect(laterSession).toMatchObject(
        done ? { lastRunId: laterRunId } : { lifecycleRunId: laterRunId },
      );
      expect(loadSubagentRegistryFromSqlite().get(runId)?.execution.status).toBe("running");

      vi.mocked(runSubagentAnnounceFlow).mockImplementation(async () => {
        // Cleanup retires this marker after the recovery owner delivers the interruption.
        expect(loadSubagentRegistryFromSqlite().get(runId)?.terminalOwner).toBe(
          "interrupted-recovery",
        );
        return "delivered";
      });
      await initSubagentRegistry();
      await fixture.activateGatewayRuntime();
      await fixture.settle();
      await testing.sweepOnceForTests();
      await fixture.settle();
      const settled = loadSubagentRegistryFromSqlite().get(runId);
      expect(settled).toMatchObject({
        execution: {
          status: "terminal",
          suppressSessionEffects: true,
          outcome: { status: "error", error: expect.stringContaining("Gateway restart") },
        },
        delivery: { status: "delivered" },
      });
      expect(loadSessionEntryReadOnly(target)).toEqual(laterSession);
      expect(fixture.dispatchAgent).not.toHaveBeenCalled();

      await resetSubagentRegistryForTests({ persist: false });
      await cleanupSessionStateForTest({ stateDir: fixture.stateDir });
      rotateAgentEventLifecycleGeneration();
      await initSubagentRegistry();
      await fixture.activateGatewayRuntime();
      await fixture.settle();
      await testing.sweepOnceForTests();
      await fixture.settle();
      expect(loadSubagentRegistryFromSqlite().get(runId)?.execution.endedAt).toBe(
        settled?.execution.endedAt,
      );
      expect(
        vi.mocked(runSubagentAnnounceFlow).mock.calls.filter(([call]) => call.childRunId === runId),
      ).toHaveLength(1);
    },
  );
});
