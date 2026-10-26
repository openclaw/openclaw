import { afterEach, expect, it, vi } from "vitest";
import {
  bindingGate,
  bindingMutation,
  interceptBindingStore,
} from "./binding-interleaving.test-support.js";
import { createNativeSessionBindingLifecycle } from "./binding-lifecycle.js";
import {
  bindingTestOptions,
  createBindingTestState,
  prepareBindingTestLease,
} from "./binding.test-support.js";
import { wrapNativeSessionDeletionMutation } from "./deletion-participant.js";

const deletion = {
  prepareLease: prepareBindingTestLease,
  assertCurrent: () => {},
  assertRecordCurrent: () => {},
};

afterEach(() => vi.useRealTimers());

function createLifecycle() {
  const { state, values } = createBindingTestState();
  return {
    state,
    values,
    lifecycle: createNativeSessionBindingLifecycle(state, bindingTestOptions),
  };
}

it("revalidates opaque native rollback authority before invoking the released SDK callback", () => {
  const rollback = vi.fn();
  const failure = new Error("opaque deletion owner retired");
  const assertCurrent = vi.fn(() => {});
  const delegate = { commit() {}, rollback };
  const mutation = wrapNativeSessionDeletionMutation(delegate, {
    assertCurrent,
    committed() {},
    rolledBack() {},
  });
  mutation.commit();
  assertCurrent.mockImplementation(() => {
    throw failure;
  });
  expect(mutation.rollback).toThrow(failure);
  expect(rollback).not.toHaveBeenCalled();
});

it("deletes only the requested owner and restores it on transaction rollback", async () => {
  const { lifecycle, values } = createLifecycle();
  const original = { value: "run" };
  values.set("base", { value: "base" });
  values.set("run", original);
  let retainedCommit: (() => void) | undefined;
  await lifecycle.withDeletion("run", deletion, async (_record, mutation) => {
    retainedCommit = mutation.commit;
    mutation.commit();
    expect([...values]).toEqual([["base", { value: "base" }]]);
    mutation.rollback();
    expect(values.get("run")).toEqual({ ...original, lease: expect.any(Object) });
    mutation.commit();
  });
  expect([...values.keys()]).toEqual(["base"]);
  expect(retainedCommit).toThrow("lease");
});

it("rejects revoked deletion authority and never restores over a successor", async () => {
  const { lifecycle, values } = createLifecycle();
  const key = "binding-owner";
  values.set(key, { value: "owner" });
  const assertCurrent = vi.fn(() => {});

  await expect(
    lifecycle.withDeletion(key, { ...deletion, assertCurrent }, async (_record, mutation) => {
      assertCurrent.mockImplementation(() => {
        throw new Error("owner revoked");
      });
      expect(mutation.commit).toThrow("owner revoked");
    }),
  ).rejects.toThrow("owner revoked");
  expect(values.get(key)).toMatchObject({ value: "owner" });

  const successor = { value: "successor" };
  await lifecycle.withDeletion(key, deletion, async (_record, mutation) => {
    mutation.commit();
    values.set(key, successor);
    expect(mutation.rollback).toThrow("changed before session deletion rollback");
  });
  expect(values.get(key)).toEqual(successor);
});

it("admits the archive owner's nested mutation", async () => {
  const { lifecycle, values } = createLifecycle();
  await expect(
    lifecycle.withExclusiveMutationFence(() =>
      lifecycle.withMutation(() => lifecycle.transact("first", () => bindingMutation("updated"))),
    ),
  ).resolves.toBe(true);
  expect([...values]).toEqual([["first", { value: "updated" }]]);
});

it("does not let a queued renewal recreate a committed deletion", async () => {
  vi.useFakeTimers();
  const { lifecycle, values, state } = createLifecycle();
  values.set("binding", { value: "original" });
  await lifecycle.withDeletion("binding", deletion, async (_record, mutation) => {
    await using gate = bindingGate();
    interceptBindingStore(state, (store) => ({
      async compareAndApply(...args) {
        await gate.pause();
        return store.compareAndApply(...args);
      },
    }));
    await vi.advanceTimersByTimeAsync(bindingTestOptions.lease.renewIntervalMs);
    await gate.reached;
    mutation.commit();
  });
  expect(values.has("binding")).toBe(false);
});
