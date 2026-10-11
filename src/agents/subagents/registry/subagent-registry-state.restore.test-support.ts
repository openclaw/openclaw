import { expect, it, vi } from "vitest";
import { sessionChanges } from "../../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import * as stateReads from "../../../state/openclaw-state-db-readonly.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { restoreSubagentRunsFromDisk } from "./subagent-registry-persistence.js";
import { persistRegistryFixture } from "./subagent-registry-state.fixture.test-support.js";
import {
  getSubagentSessionListRunsSnapshotForRead,
  getSubagentRunsSnapshotForRead,
} from "./subagent-registry-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function registerSubagentRestoreCacheCases(params: {
  createRun: (runId: string) => SubagentRunRecord;
  mockRestoredRows(runs: Map<string, SubagentRunRecord>): void;
  refuseNextWrite(): void;
}) {
  const { createRun } = params;
  it("publishes restored rows together after replacing ownership and cached facts", async () => {
    subagentRuns.clear();
    const previous = { ...createRun("replaced"), generation: 1 };
    persistRegistryFixture(new Map([[previous.runId, previous]]));
    subagentRuns.set(previous.runId, previous);
    const registration = subagentRuns.captureRegistrationOwnership(
      previous.childSessionKey,
      previous,
    );
    const restored = new Map<string, SubagentRunRecord>([
      [previous.runId, { ...previous, generation: 2 }],
      ["second", createRun("second")],
    ]);
    params.mockRestoredRows(restored);
    const observe = vi.fn(() => ({
      live: [...subagentRuns.keys()],
      cached: [...getSubagentSessionListRunsSnapshotForRead(new Map()).keys()],
      superseded: registration.superseded,
    }));
    const unsubscribe = sessionChanges.subscribe(observe);
    try {
      await restoreSubagentRunsFromDisk({ runs: subagentRuns });
      expect(observe.mock.results).toEqual([
        {
          type: "return",
          value: { live: [...restored.keys()], cached: [...restored.keys()], superseded: true },
        },
      ]);
      expect(registration.assertCurrent).toThrow("owner changed");
    } finally {
      unsubscribe();
      registration.release();
      subagentRuns.clear();
    }
  });

  it.each([false, true])(
    "invalidates loaded snapshots on restore, including empty stores (%s)",
    async (empty) => {
      const stale = createRun("stale");
      persistRegistryFixture(new Map([[stale.runId, stale]]));
      const restored = empty
        ? new Map<string, SubagentRunRecord>()
        : new Map([["restored", createRun("restored")]]);
      params.mockRestoredRows(restored);

      await restoreSubagentRunsFromDisk({ runs: new Map() });

      for (const read of [
        getSubagentRunsSnapshotForRead,
        getSubagentSessionListRunsSnapshotForRead,
      ]) {
        expect([...read(new Map()).keys()]).toEqual([...restored.keys()]);
      }
    },
  );

  it.each([true, false])(
    "restores canonical rows across an external deletion publication (committed: %s)",
    async (committed) => {
      const entry = createRun("retained");
      const canonical = new Map([[entry.runId, entry]]);
      persistRegistryFixture(canonical);
      const entered = createDeferredCore();
      const release = createDeferredCore();
      let reads = 0;
      vi.mocked(stateReads.executeExistingOpenClawStateRead).mockImplementation(
        async (_options, command, options) => {
          expect(command).toEqual({ type: "subagents.restore" });
          const snapshot = structuredClone(canonical);
          if (++reads === 1) {
            entered.resolve();
            await release.promise;
          }
          options?.onChunk?.(
            [...snapshot.values()].map((restored) => ({
              entry: restored,
              version: "fixture-version",
              createdAt: restored.createdAt,
            })),
          );
          return {
            ok: true,
            type: "subagents.restore",
            sourceAdmitted: true,
            count: snapshot.size,
          };
        },
      );
      const restored = new Map<string, SubagentRunRecord>();
      const restoring = restoreSubagentRunsFromDisk({ runs: restored });
      try {
        await entered.promise;
        if (committed) {
          persistRegistryFixture(new Map(), [entry.runId]);
          canonical.delete(entry.runId);
        } else {
          params.refuseNextWrite();
          expect(() => persistRegistryFixture(new Map(), [entry.runId])).toThrow("write refused");
        }
      } finally {
        release.resolve();
      }
      await restoring;
      expect(reads).toBe(committed ? 2 : 1);
      expect(restored.has(entry.runId)).toBe(!committed);
      expect(getSubagentRunsSnapshotForRead(new Map()).has(entry.runId)).toBe(!committed);
    },
  );
}
