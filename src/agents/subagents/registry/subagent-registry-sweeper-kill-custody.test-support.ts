import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { getAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import { prepareSubagentKillSession } from "./subagent-control-session.js";
import { reconcileDurableSubagentKillIntent } from "./subagent-registry-sweep-kill.js";
import {
  createSubagentSweeperChildLookup as childRuns,
  createSubagentSweeperRun as run,
} from "./subagent-registry-sweeper.test-support.js";

export function registerSubagentSweepKillCustodyTests(killSessionEntry: {
  current: { sessionId: string; lifecycleRevision?: string; updatedAt: number } | undefined;
}) {
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
      const entered = createDeferred();
      const prepared = createDeferred();
      const prepare = vi.mocked(prepareSubagentKillSession).getMockImplementation();
      if (!prepare) {
        throw new Error("Missing synthetic session preparation");
      }
      vi.mocked(prepareSubagentKillSession).mockImplementation(async (...args) => {
        entered.resolve();
        await prepared.promise;
        return prepare(...args);
      });
      const completeSubagentRunWithRecovery = vi.fn();
      const retireSupersededRun = vi.fn();
      const pending = reconcileDurableSubagentKillIntent({
        runId: entry.runId,
        entry,
        runs,
        getRunsForChildSession: childRuns(runs),
        retireObligations: vi.fn(async () => {}),
        completeSubagentRunWithRecovery,
        retireSupersededRun,
        warn: vi.fn(),
      });

      try {
        if (change === "existing successor") {
          await pending;
        } else {
          await entered.promise;
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
        prepared.resolve();
        await pending;
        vi.mocked(prepareSubagentKillSession).mockImplementation(prepare);
      }

      await expect(pending).resolves.toBe(
        change === "session revision" || change === "existing successor",
      );
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
