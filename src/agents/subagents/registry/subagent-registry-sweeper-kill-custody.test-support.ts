import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { getAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import { prepareSubagentKillSession } from "./subagent-control-session.js";
import { reconcileDurableSubagentKillIntent } from "./subagent-registry-sweep-kill.js";
import {
  mockSubagentSweeperChildLookup,
  createSubagentSweeperRun as run,
} from "./subagent-registry-sweeper.test-support.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function createSubagentKillFixture() {
  const killIntent: NonNullable<ReturnType<typeof run>["killIntent"]> = {
    requestedAt: Date.now(),
    reason: "killed",
    sessionId: "session-id",
    lifecycleGeneration: getAgentEventLifecycleGeneration(),
    sessionLifecycleRevision: "session-revision",
  };
  const entry = { ...run(), killIntent };
  const runs = new Map<string, SubagentRunRecord>([[entry.runId, entry]]);
  const childLookup = mockSubagentSweeperChildLookup(runs);
  const options = {
    runId: entry.runId,
    entry,
    runs,
    getRunsForChildSession: childLookup,
    completeSubagentRunWithRecovery: vi.fn(async () => {}),
    retireSupersededRun: vi.fn(),
    retireObligations: vi.fn(async () => {}),
    warn: vi.fn(),
  };
  return { ...options, childLookup, reconcile: () => reconcileDurableSubagentKillIntent(options) };
}

export function registerSubagentSweepKillCustodyTests(killSessionEntry: {
  current: { sessionId: string; lifecycleRevision?: string; updatedAt: number } | undefined;
}) {
  it.each(["same run id", "newer generation", "session revision", "existing successor"] as const)(
    "fences a durable kill when a %s replaces its owner",
    async (change) => {
      const h = createSubagentKillFixture();
      const { entry, runs } = h;
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
      const pending = h.reconcile();

      try {
        if (change !== "existing successor") {
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
        h.childLookup.mockRestore();
        vi.mocked(prepareSubagentKillSession).mockImplementation(prepare);
      }

      await expect(pending).resolves.toBe(
        change === "session revision" || change === "existing successor",
      );
      const completion = [
        expect.objectContaining({
          runId: entry.runId,
          expectedEntry: entry,
          suppressSessionEffects: true,
        }),
        "sweeper-retired-kill-intent",
      ];
      expect(h.completeSubagentRunWithRecovery.mock.calls).toEqual(
        change === "session revision" ? [completion] : [],
      );
      expect(h.retireSupersededRun.mock.calls).toEqual(
        change === "existing successor" ? [[entry.runId, entry]] : [],
      );
    },
  );
}
