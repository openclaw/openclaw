import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../shared/deferred.js";
import * as stateReads from "../../../state/openclaw-state-db-readonly.js";
import {
  getSubagentMaintenanceRunsSnapshotForRead,
  getSubagentSessionListRunsSnapshotForRead,
  getSubagentRunsSnapshotForRead,
  persistSubagentRunsToDisk,
  persistSubagentRunsToDiskOrThrow,
  restoreSubagentRunsFromDisk,
} from "./subagent-registry-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function registerSubagentRestoreCacheCases(params: {
  createRun: (runId: string) => SubagentRunRecord;
  mockRestoredRows(runs: Map<string, SubagentRunRecord>): void;
  refuseNextWrite(): void;
}) {
  const { createRun } = params;
  it.each([false, true])(
    "invalidates loaded snapshots on restore, including empty stores (%s)",
    async (empty) => {
      const stale = createRun("stale");
      persistSubagentRunsToDisk(new Map([[stale.runId, stale]]));
      const restored = empty
        ? new Map<string, SubagentRunRecord>()
        : new Map([["restored", createRun("restored")]]);
      params.mockRestoredRows(restored);

      await restoreSubagentRunsFromDisk({ runs: new Map() });

      for (const read of [
        getSubagentRunsSnapshotForRead,
        getSubagentSessionListRunsSnapshotForRead,
        getSubagentMaintenanceRunsSnapshotForRead,
      ]) {
        expect([...read(new Map()).keys()]).toEqual([...restored.keys()]);
      }
    },
  );

  it.each([true, false])(
    "restores canonical rows across a concurrent deletion (committed: %s)",
    async (committed) => {
      const entry = createRun("retained");
      const canonical = new Map([[entry.runId, entry]]);
      persistSubagentRunsToDiskOrThrow(canonical);
      const entered = createDeferredCore();
      const release = createDeferredCore();
      let reads = 0;
      vi.mocked(stateReads.executeExistingOpenClawStateRead).mockImplementation(
        async (_options, command) => {
          expect(command).toEqual({ type: "subagents.runs", scope: { kind: "all" } });
          const snapshot = structuredClone(canonical);
          if (++reads === 1) {
            entered.resolve();
            await release.promise;
          }
          return { ok: true, type: "subagents.runs", sourceAdmitted: true, runs: snapshot };
        },
      );
      const restored = new Map<string, SubagentRunRecord>();
      const restoring = restoreSubagentRunsFromDisk({ runs: restored });
      try {
        await entered.promise;
        if (committed) {
          persistSubagentRunsToDiskOrThrow(new Map(), [entry.runId]);
          canonical.delete(entry.runId);
        } else {
          params.refuseNextWrite();
          persistSubagentRunsToDisk(new Map(), [entry.runId]);
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
