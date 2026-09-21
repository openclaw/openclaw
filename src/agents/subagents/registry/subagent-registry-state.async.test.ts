// Real-storage proof that committed and best-effort publications survive read-owner retirement.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../shared/deferred.js";
import { createOpenClawDatabaseMaintenanceScope } from "../../../state/openclaw-state-db-async-lifecycle.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  registerOpenClawStateDatabaseAsyncResource,
} from "../../../state/openclaw-state-db-cache.js";
import * as databaseCache from "../../../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import {
  clearSubagentRunsReadCacheForTest,
  getSubagentRunsSnapshotForRead,
  getSubagentMaintenanceRunsSnapshotForRead,
  getSubagentSessionListRunsSnapshotForRead,
  onSubagentRegistryPersisted,
  persistSubagentRunsToDisk,
  persistSubagentRunsToDiskOrThrow,
  publishSubagentRunsAfterAtomicStore,
} from "./subagent-registry-state.js";
import * as store from "./subagent-registry.store.sqlite.js";

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ scenario: "minimal", applyEnv: true });
  openOpenClawStateDatabase();
  vi.stubEnv("OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE", "1");
  clearSubagentRunsReadCacheForTest();
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearSubagentRunsReadCacheForTest();
  await state.cleanup();
});
function runs(model: string, runId = "one") {
  const run = createSubagentRunRecord({
    runId,
    childSessionKey: `agent:main:subagent:${runId}`,
    model,
    completion: { required: false },
    delivery: { status: "not_required" },
  });
  return new Map([[run.runId, run]]);
}

it.each(["best effort", "strict refusal", "strict commit", "atomic commit"])(
  "keeps %s publication independent of retired read admission",
  async (mode) => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    persistSubagentRunsToDiskOrThrow(runs("before"), ["one"]);
    const database = openOpenClawStateDatabase();
    const context = captureOpenClawStateWorkerContext();
    const current = runs("after");
    const entry = current.get("one")!;
    entry.execution = { status: "terminal", endedAt: 2, outcome: { status: "ok" } };
    entry.cleanupCompletedAt = 2;
    const wake = vi.fn();
    const unsubscribe = onSubagentRegistryPersisted(wake);
    const releaseClose = createDeferredCore();
    const unregister = registerOpenClawStateDatabaseAsyncResource({
      close: () => releaseClose.promise,
    });
    const events: Array<() => void> = [];
    const publish = () => {
      if (mode === "atomic commit") {
        publishSubagentRunsAfterAtomicStore(current, ["one"], events);
      } else if (mode === "best effort") {
        persistSubagentRunsToDisk(current, ["one"]);
      } else {
        persistSubagentRunsToDiskOrThrow(current, ["one"]);
      }
    };
    if (mode === "atomic commit") {
      store.saveSubagentRegistryChangesToSqlite(current, ["one"]);
    }
    const resumePublication = createDeferredCore();
    let publication: Promise<void> | undefined;
    if (mode === "best effort" || mode === "strict refusal") {
      const scope = createOpenClawDatabaseMaintenanceScope();
      scope.run(() => {
        publication = resumePublication.promise.then(publish);
      });
      await scope.close();
    }
    const closing = closeOpenClawStateDatabaseByPathAsync(context.admission.databasePath);
    try {
      expect(() => captureOpenClawStateWorkerContext()).toThrow("read admission is closed");
      if (publication) {
        const observed =
          mode === "strict refusal"
            ? expect(publication).rejects.toThrow("maintenance resource scope is closed")
            : expect(publication).resolves.toBeUndefined();
        resumePublication.resolve();
        await observed;
      } else {
        expect(publish).not.toThrow();
      }
      const committed = mode === "strict commit" || mode === "atomic commit";
      expect(store.readSubagentRun(database, "one")?.model).toBe(committed ? "after" : "before");
      const refused = mode === "strict refusal";
      expect(getSubagentRunsSnapshotForRead(new Map()).get("one")).toMatchObject({
        model: refused ? "before" : "after",
        execution: { status: refused ? "running" : "terminal" },
      });
      const maintenance = getSubagentMaintenanceRunsSnapshotForRead(new Map()).get("one");
      expect(maintenance?.execution.status).toBe(refused ? "running" : "terminal");
      expect(maintenance?.cleanupCompletedAt).toBe(refused ? undefined : 2);
      expect(events).toHaveLength(mode === "atomic commit" ? 1 : 0);
      events.forEach((event) => event());
      expect(wake).toHaveBeenCalledTimes(refused ? 0 : 1);
    } finally {
      resumePublication.resolve();
      releaseClose.resolve();
      await closing;
      unregister();
      unsubscribe();
    }
    store.saveSubagentRegistryChangesToSqlite(runs("reopened"), ["one"]);
    expect(getSubagentSessionListRunsSnapshotForRead(new Map()).get("one")?.model).toBe("reopened");
  },
);

it("keeps unrelated publication context failures visible", () => {
  const failure = new Error("synthetic context failure");
  vi.spyOn(databaseCache, "captureOpenClawStateDatabaseReadAdmission").mockImplementationOnce(
    () => {
      throw failure;
    },
  );
  expect(() => persistSubagentRunsToDisk(runs("current"), ["one"])).toThrow(failure);
});
