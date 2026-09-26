import { setImmediate as immediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as mutationAdmission from "../../../infra/sqlite-worker-operation-admission.js";
import {
  createPluginStateKeyedStore,
  createPluginStateSyncKeyedStore,
} from "../../../plugin-state/plugin-state-store.js";
import { holdStateCoordinator } from "../../../state/openclaw-state-coordinator.test-support.js";
import { resolveOpenClawStateSqlitePath } from "../../../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { createNativeSessionBindingLeases } from "./binding-leases.js";
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
  const asyncState = createPluginStateKeyedStore<TestBindingRecord>("binding-proof", options);
  const syncState = createPluginStateSyncKeyedStore<TestBindingRecord>("binding-proof", options);
  const state = { ...syncState, withCurrent: asyncState.withCurrent!.bind(asyncState) };
  return { state, asyncState, owner: createNativeSessionBindingLeases(state, bindingTestOptions) };
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
      const release = await holdStateCoordinator(resolveOpenClawStateSqlitePath(fixture.env));
      let settled = false;
      const mutation = owner
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
      let progressedBeforeSettlement = false;
      try {
        await immediate();
        await release.observe();
        progressedBeforeSettlement = !settled;
      } finally {
        await release();
        await mutation;
      }
      const result = await mutation;
      expect(progressedBeforeSettlement).toBe(true);
      expect(result).toEqual({ value: "stored" });
      expect(await asyncState.lookup("binding")).toEqual({ value: "after" });
    });
  });

  it.each(["revocation", "lease expiry", "acquisition expiry"] as const)(
    "refuses %s at native commit without publishing a prepared binding",
    async (failure) => {
      await withOpenClawTestState({ label: "binding-worker-authority" }, async (fixture) => {
        vi.useFakeTimers({ toFake: ["Date"] });
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
        const admission = mutationAdmission.createSqliteWorkerOperationAdmission;
        vi.spyOn(mutationAdmission, "createSqliteWorkerOperationAdmission").mockImplementation(
          (admit, attachment) =>
            admission((request, grant) => {
              if (request.stage === "commit" && prepared && !refusedCommit) {
                refusedCommit = true;
                if (failure === "revocation") {
                  current = false;
                } else {
                  vi.setSystemTime(Date.now() + bindingTestOptions.lease.staleMs + 1);
                }
              }
              admit(request, grant);
            }, attachment),
        );
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
              prepareLease(record, lease) {
                prepared = failure === "acquisition expiry";
                return prepareBindingTestLease(record, lease);
              },
              assertCurrent,
            },
          ),
        ).rejects.toThrow();
        expect(refusedCommit).toBe(true);
        expect(entered).toBe(failure !== "acquisition expiry");
        const stored = await asyncState.lookup("binding");
        if (failure === "acquisition expiry") {
          expect(stored).toEqual({ value: "before" });
        } else {
          expect(stored).toMatchObject({ value: "before" });
        }
      });
    },
  );
});
