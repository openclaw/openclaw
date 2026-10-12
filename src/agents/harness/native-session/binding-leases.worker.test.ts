import { setImmediate as immediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as mutationAdmission from "../../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../../infra/sqlite-worker-owner-probe.test-support.js";
import {
  createPluginStateKeyedStoreV2,
  createPluginStateSyncKeyedStore,
  type PluginStateActionAuthority,
} from "../../../plugin-state/plugin-state-store.js";
import { resolveOpenClawStateSqlitePath } from "../../../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { holdStateDatabaseWriteTransaction } from "../../../test-utils/state-database-contention.js";
import { createNativeSessionBindingLeasesV2 } from "./binding-leases.js";
import {
  bindingTestOptions,
  prepareBindingTestLease,
  type TestBindingRecord,
} from "./binding.test-support.js";

function bindingStores(env: NodeJS.ProcessEnv) {
  const options = {
    namespace: "bindings",
    maxEntries: 10,
    overflowPolicy: "reject-new" as const,
    env,
  };
  const asyncState = createPluginStateKeyedStoreV2<TestBindingRecord>("binding-proof", options, {
    assertCurrent() {},
  });
  const syncState = createPluginStateSyncKeyedStore<TestBindingRecord>("binding-proof", options);
  const state = {
    withCurrent(authority: PluginStateActionAuthority) {
      return createPluginStateKeyedStoreV2<TestBindingRecord>("binding-proof", options, authority);
    },
    assertLeaseCurrent(key: string, token: string) {
      const lease = syncState.lookup(key)?.lease;
      if (lease?.token !== token || lease.expiresAt <= Date.now()) {
        throw bindingTestOptions.errors.lostLease(key);
      }
    },
  };
  return {
    state,
    asyncState,
    owner: createNativeSessionBindingLeasesV2(state, bindingTestOptions),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("native binding worker admission", () => {
  it("allows host progress to release a competing writer before persisting the binding", async () => {
    await withOpenClawTestState({ label: "binding-worker-contention" }, async (fixture) => {
      const { owner, asyncState } = bindingStores(fixture.env);
      await asyncState.register("binding", { value: "before" });
      const holder = holdStateDatabaseWriteTransaction(
        resolveOpenClawStateSqlitePath(fixture.env),
        1_000,
      );
      let settled = false;
      let mutation: Promise<{ value: string } | { error: unknown }> | undefined;
      let progressedBeforeSettlement = false;
      try {
        await holder.ready;
        mutation = owner
          .transact("binding", (current) => ({
            next: { ...current, value: "after" },
            result: "stored",
          }))
          .then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          )
          .finally(() => {
            settled = true;
          });
        await immediate();
        progressedBeforeSettlement = !settled && Atomics.load(holder.released, 0) === 0;
      } finally {
        holder.release();
        await mutation;
        await holder.joined;
      }
      const result = await mutation;
      expect(progressedBeforeSettlement).toBe(true);
      expect(result).toEqual({ value: "stored" });
      expect(await asyncState.lookup("binding")).toEqual({ value: "after" });
    });
  });

  it("refuses revocation at native commit without publishing a prepared binding", async () => {
    await withOpenClawTestState({ label: "binding-worker-authority" }, async (fixture) => {
      const { owner, asyncState } = bindingStores(fixture.env);
      await asyncState.register("binding", { value: "before" });
      let current = true;
      let prepared = false;
      let entered = false;
      let refusedCommit = false;
      const assertCurrent = () => {
        if (!current) {
          throw new Error("binding action revoked");
        }
      };
      probe.admission(mutationAdmission, (request, grant, admit) => {
        if (request.stage === "commit" && prepared && !refusedCommit) {
          refusedCommit = true;
          current = false;
        }
        admit(request, grant);
      });
      await expect(
        owner.withLease(
          "binding",
          () => {
            entered = true;
            return owner.transact(
              "binding",
              (record) => {
                prepared = true;
                return { next: { ...record, value: "unauthorized" }, result: true };
              },
              undefined,
              assertCurrent,
            );
          },
          {
            prepareLease: prepareBindingTestLease,
            assertCurrent,
          },
        ),
      ).rejects.toThrow();
      expect(refusedCommit).toBe(true);
      expect(entered).toBe(true);
      const stored = await asyncState.lookup("binding");
      expect(stored).toMatchObject({ value: "before" });
    });
  });
});
