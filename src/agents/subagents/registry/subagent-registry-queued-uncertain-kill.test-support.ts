import { expect, it, vi } from "vitest";
import { SqliteWorkerError } from "../../../infra/sqlite-worker-contract.js";
import * as databaseLifecycle from "../../../state/openclaw-state-db-cache.js";
import * as stateReads from "../../../state/openclaw-state-db-readonly.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import type { createQueuedRegistrationFixture } from "./subagent-registry-queued-registration.test-support.js";
import * as registryState from "./subagent-registry-state.js";
import * as registryStore from "./subagent-registry.store.sqlite.js";

export function registerQueuedUnknownKillAuthorityTest(params: {
  fixture: () => ReturnType<typeof createQueuedRegistrationFixture>;
  getContext: () => OpenClawStateWorkerContext;
}) {
  it("retains uncertain kill custody across source close without blocking another queued run", async () => {
    const f = params.fixture();
    const unrelated = params.fixture();
    unrelated.registration.runId = "unrelated-registration";
    unrelated.registration.childSessionKey = "agent:main:subagent:unrelated-registration";
    f.acknowledgeAllWrites();
    unrelated.acknowledgeAllWrites();
    await f.register();
    await unrelated.register();
    const entry = f.runs.get(f.registration.runId)!;
    const canonical = structuredClone(new Map([...f.runs, ...unrelated.runs]));
    const readCanonical = vi
      .spyOn(registryStore, "loadSubagentRegistryFromSqlite")
      .mockImplementation(() => structuredClone(canonical));
    vi.spyOn(stateReads, "executeExistingOpenClawStateRead").mockImplementation(
      async (_options, command) => {
        expect(command).toEqual({ type: "subagents.runs", scope: { kind: "all" } });
        return {
          ok: true,
          type: "subagents.runs",
          sourceAdmitted: true,
          runs: readCanonical(),
        };
      },
    );
    vi.spyOn(databaseLifecycle, "captureOpenClawStateDatabaseReadAdmission").mockImplementation(
      () => params.getContext().admission,
    );
    const worker = vi
      .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
      .mockRejectedValueOnce(new SqliteWorkerError("Kill acknowledgement lost", "outcome-unknown"));
    f.options.persistAsyncOrThrow.mockImplementation((context, callbacks, ...ids) =>
      registryState.persistSubagentRunsToDiskAsyncOrThrow(f.runs, ids, { context, ...callbacks }),
    );
    const usable = (scope: typeof f.scope) => [
      scope.canLaunch(),
      scope.canAcceptLaunch(),
      scope.canCleanupSession(),
    ];
    try {
      expect(usable(f.scope)).toEqual([true, true, true]);
      expect(usable(unrelated.scope)).toEqual([true, true, true]);
      await expect(
        f.manager.claimSubagentRunKill({ runId: entry.runId, expected: entry }),
      ).rejects.toMatchObject({ outcome: "unknown" });
      expect(entry.killIntent).toBeUndefined();
      expect(entry.execution.status).toBe("queued");
      expect(usable(f.scope)).toEqual([false, false, false]);
      expect(usable(unrelated.scope)).toEqual([true, true, true]);
      await expect(
        registryState.restoreSubagentRunsFromDisk({ runs: f.runs }),
      ).rejects.toMatchObject({ outcome: "unknown" });
      await databaseLifecycle.closeOpenClawStateDatabaseAsync();
      expect(usable(f.scope)).toEqual([false, false, false]);
      await expect(
        registryState.restoreSubagentRunsFromDisk({ runs: f.runs, mergeOnly: true }),
      ).rejects.toMatchObject({ outcome: "unknown" });
      await expect(
        f.manager.claimSubagentRunKill({ runId: entry.runId, expected: entry }),
      ).rejects.toMatchObject({ outcome: "unknown" });
      expect(worker).toHaveBeenCalledOnce();
      await registryState.restoreSubagentRunsFromDisk({ runs: f.runs });
      expect(f.runs.get(entry.runId)).not.toBe(entry);
      expect(f.runs.get(entry.runId)).toEqual(canonical.get(entry.runId));
      expect(usable(f.scope)).toEqual([false, false, false]);
      expect(usable(unrelated.scope)).toEqual([true, true, true]);
    } finally {
      await databaseLifecycle.closeOpenClawStateDatabaseAsync();
      readCanonical.mockReturnValue(new Map());
      await registryState.restoreSubagentRunsFromDisk({ runs: new Map() });
      registryState.clearSubagentRunsReadCacheForTest();
    }
  });
}
