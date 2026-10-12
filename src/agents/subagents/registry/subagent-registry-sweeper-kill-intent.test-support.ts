/**
 * Durable kill-intent reconciliation cases for the registry sweeper.
 *
 * Extracted from subagent-registry-sweeper-recovery.test.ts so that file stays
 * under its line cap. The hoisted runtime/session mocks the suite owns are
 * handed in through the fixture rather than re-declared here.
 */
import { expect, it, type Mock, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { resolveSessionStorePathCore } from "../../../config/sessions.js";
import { replaceSessionEntrySync } from "../../../config/sessions/session-accessor.js";
import { createMockGatewayRecoveryRuntime } from "../../../gateway/server-recovery-runtime.test-support.js";
import { getAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import { observeMainThreadSql } from "../../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { prepareSubagentKillSession } from "./subagent-control-session.js";
import { reconcileDurableSubagentKillIntent } from "./subagent-registry-sweep-kill.js";
import type {
  createSubagentSweeperChildLookup,
  createSubagentSweeperHarness,
  createSubagentSweeperRun,
} from "./subagent-registry-sweeper.test-support.js";

type KillIntentFixture = {
  createHarness: typeof createSubagentSweeperHarness;
  childRuns: typeof createSubagentSweeperChildLookup;
  run: typeof createSubagentSweeperRun;
  getAgentRunContext: ReturnType<typeof vi.fn>;
  killRuntime: {
    abortEmbeddedAgentRun: Mock<() => boolean>;
    isEmbeddedAgentRunActive: Mock<() => boolean>;
    clearSessionLifecycleQueues: Mock<
      () => { followupCleared: number; laneCleared: number; keys: string[] }
    >;
  };
  killSessionEntry: {
    current: { sessionId: string; lifecycleRevision?: string; updatedAt: number } | undefined;
  };
};

export function registerSubagentSweeperKillIntentTests({
  createHarness,
  childRuns,
  run,
  getAgentRunContext,
  killRuntime,
  killSessionEntry,
}: KillIntentFixture) {
  it("does not terminalize a durable kill intent while runtime abort is rejected", async () => {
    const runtime = { current: createMockGatewayRecoveryRuntime() };
    const { entry, completeSubagentRunWithRecovery, sweeper } = createHarness(runtime);
    entry.killIntent = {
      requestedAt: Date.now(),
      reason: "killed",
      sessionId: "session-id",
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      sessionLifecycleRevision: "session-revision",
    };
    getAgentRunContext.mockReturnValue({});
    killRuntime.isEmbeddedAgentRunActive.mockReturnValue(true);

    await sweeper.sweepOnce();

    expect(killRuntime.abortEmbeddedAgentRun).toHaveBeenCalledWith("session-id");
    expect(killRuntime.clearSessionLifecycleQueues).toHaveBeenCalledWith({
      keys: [entry.childSessionKey, "session-id"],
      agentId: "main",
      sessionKey: entry.childSessionKey,
      sessionId: "session-id",
      assertCurrent: expect.any(Function),
    });
    expect(completeSubagentRunWithRecovery).not.toHaveBeenCalled();

    getAgentRunContext.mockReturnValue(undefined);
    killRuntime.isEmbeddedAgentRunActive.mockReturnValue(false);
    await sweeper.sweepOnce();

    expect(completeSubagentRunWithRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: entry.runId,
        expectedEntry: entry,
        reason: "subagent-killed",
      }),
      "sweeper-pending-kill-intent",
    );
  });

  it("reconciles a raw child's kill intent in its recorded agent's configured store", async () => {
    const actual = await vi.importActual<typeof import("./subagent-control-session.js")>(
      "./subagent-control-session.js",
    );
    await vi
      .mocked(prepareSubagentKillSession)
      .withImplementation(actual.prepareSubagentKillSession, async () => {
        await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
          const { entry, runs, completeSubagentRunWithRecovery } = createHarness({});
          entry.childSessionKey = "global";
          entry.childAgentId = "research";
          const cfg = getRuntimeConfig();
          const storePath = resolveSessionStorePathCore(cfg.session?.store, {
            agentId: "research",
          });
          replaceSessionEntrySync(
            { agentId: "research", storePath, sessionKey: "global", env: state.env },
            {
              sessionId: "research-session",
              lifecycleRevision: "research-revision",
              updatedAt: Date.now(),
            },
          );
          replaceSessionEntrySync(
            { agentId: "main", sessionKey: "global", env: state.env },
            {
              sessionId: "main-session",
              lifecycleRevision: "main-revision",
              updatedAt: Date.now(),
            },
          );
          entry.killIntent = {
            requestedAt: Date.now(),
            reason: "killed",
            sessionId: "research-session",
            sessionLifecycleRevision: "research-revision",
            lifecycleGeneration: getAgentEventLifecycleGeneration(),
          };
          const foreign = {
            ...entry,
            runId: "main-foreign-run",
            generation: (entry.generation ?? 0) + 1,
            createdAt: entry.createdAt + 1,
            childAgentId: "main",
            killIntent: undefined,
          };
          runs.set(foreign.runId, foreign);
          killRuntime.isEmbeddedAgentRunActive.mockReturnValue(true);
          killRuntime.abortEmbeddedAgentRun.mockReturnValue(true);
          const sql = observeMainThreadSql();
          try {
            expect(
              await reconcileDurableSubagentKillIntent({
                runId: entry.runId,
                entry,
                runs,
                getRunsForChildSession: childRuns(runs),
                loadKillRuntime: async () => killRuntime,
                completeSubagentRunWithRecovery,
                retireSupersededRun: vi.fn(),
                warn: vi.fn(),
              }),
            ).toBe(true);
            sql.expectIdle();
          } finally {
            sql.restore();
          }
          expect(killRuntime.abortEmbeddedAgentRun).toHaveBeenCalledExactlyOnceWith(
            "research-session",
          );
          expect(killRuntime.clearSessionLifecycleQueues).toHaveBeenCalledExactlyOnceWith({
            keys: ["global", "research-session"],
            agentId: "research",
            sessionKey: "global",
            sessionId: "research-session",
            assertCurrent: expect.any(Function),
          });
          expect(completeSubagentRunWithRecovery).toHaveBeenCalledWith(
            expect.not.objectContaining({ suppressSessionEffects: true }),
            "sweeper-pending-kill-intent",
          );
        });
      });
  });

  it("terminalizes a legacy unowned kill without touching the current child session", async () => {
    const runtime = { current: createMockGatewayRecoveryRuntime() };
    const { entry, completeSubagentRunWithRecovery, sweeper } = createHarness(runtime);
    entry.killIntent = {
      requestedAt: Date.now(),
      reason: "legacy killed",
      sessionId: "session-id",
    };

    await sweeper.sweepOnce();

    expect(killRuntime.isEmbeddedAgentRunActive).not.toHaveBeenCalled();
    expect(killRuntime.abortEmbeddedAgentRun).not.toHaveBeenCalled();
    expect(killRuntime.clearSessionLifecycleQueues).not.toHaveBeenCalled();
    expect(completeSubagentRunWithRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: entry.runId,
        expectedEntry: entry,
        suppressSessionEffects: true,
      }),
      "sweeper-retired-kill-intent",
    );
  });

  it.each(["same run id", "newer generation", "session revision", "existing successor"] as const)(
    "fences a durable kill when a %s replaces its owner",
    async (change) => {
      const entry = run();
      entry.killIntent = {
        requestedAt: Date.now(),
        reason: "killed",
        sessionId: "session-id",
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        sessionLifecycleRevision: "session-revision",
      };
      const runs = new Map([[entry.runId, entry]]);
      const addSuccessor = () => {
        const newer = {
          ...run(),
          runId: "newer-kill-run",
          generation: (entry.generation ?? 0) + 1,
          createdAt: entry.createdAt + 1,
        };
        runs.set(newer.runId, newer);
      };
      if (change === "existing successor") {
        entry.killIntent.lifecycleGeneration = undefined;
        entry.killIntent.sessionLifecycleRevision = undefined;
        addSuccessor();
      }
      const runtime = createDeferred<typeof import("./subagent-control.runtime.js")>();
      const loadKillRuntime = vi.fn(() => runtime.promise);
      const completeSubagentRunWithRecovery = vi.fn();
      const retireSupersededRun = vi.fn();
      const pending = reconcileDurableSubagentKillIntent({
        runId: entry.runId,
        entry,
        runs,
        getRunsForChildSession: childRuns(runs),
        loadKillRuntime,
        completeSubagentRunWithRecovery,
        retireSupersededRun,
        warn: vi.fn(),
      });

      try {
        if (change === "existing successor") {
          expect(loadKillRuntime).not.toHaveBeenCalled();
        } else {
          expect(loadKillRuntime).toHaveBeenCalledOnce();
          if (change === "same run id") {
            runs.set(entry.runId, run());
          } else if (change === "newer generation") {
            addSuccessor();
          } else {
            killSessionEntry.current = {
              sessionId: "session-id",
              lifecycleRevision: "replacement-revision",
              updatedAt: Date.now(),
            };
          }
        }
      } finally {
        runtime.resolve(killRuntime);
        await pending;
      }

      await expect(pending).resolves.toBe(
        change === "session revision" || change === "existing successor",
      );
      expect(killRuntime.isEmbeddedAgentRunActive).not.toHaveBeenCalled();
      expect(killRuntime.abortEmbeddedAgentRun).not.toHaveBeenCalled();
      expect(killRuntime.clearSessionLifecycleQueues).not.toHaveBeenCalled();
      if (change === "session revision") {
        expect(completeSubagentRunWithRecovery).toHaveBeenCalledWith(
          expect.objectContaining({
            runId: entry.runId,
            expectedEntry: entry,
            suppressSessionEffects: true,
          }),
          "sweeper-retired-kill-intent",
        );
      } else {
        expect(completeSubagentRunWithRecovery).not.toHaveBeenCalled();
      }
      if (change === "existing successor") {
        expect(retireSupersededRun).toHaveBeenCalledWith(entry.runId, entry);
      } else {
        expect(retireSupersededRun).not.toHaveBeenCalled();
      }
    },
  );
}
