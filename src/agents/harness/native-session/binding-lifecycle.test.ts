import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { bindingMutation, interceptBindingStore } from "./binding-interleaving.test-support.js";
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

function createLifecycle(beforeApply?: () => void | Promise<void>) {
  const { state, values } = createBindingTestState();
  if (beforeApply) {
    interceptBindingStore(state, (store) => ({
      async compareAndApply(...args) {
        const pending = beforeApply();
        if (pending) {
          await pending;
        }
        return store.compareAndApply(...args);
      },
    }));
  }
  return { values, lifecycle: createNativeSessionBindingLifecycle(state, bindingTestOptions) };
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
  expect(() => mutation.rollback()).toThrow(failure);
  expect(rollback).not.toHaveBeenCalled();
});

it("deletes only the requested owner and restores it on transaction rollback", async () => {
  const { lifecycle, values } = createLifecycle();
  const original = { value: "run" };
  values.set("base", { value: "base" });
  values.set("run", original);

  await lifecycle.withDeletion("run", deletion, async (_record, mutation) => {
    mutation.commit();
    expect([...values]).toEqual([["base", { value: "base" }]]);
    mutation.rollback();
  });
  expect(values.get("run")).toEqual(original);
  let retainedCommit: (() => void) | undefined;
  await lifecycle.withDeletion("run", deletion, async (_record, mutation) => {
    retainedCommit = mutation.commit;
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
  values.set(key, successor);
  await lifecycle.withDeletion(key, deletion, async (_record, mutation) => {
    mutation.commit();
    values.set(key, successor);
    expect(mutation.rollback).toThrow("changed before session deletion rollback");
  });
  expect(values.get(key)).toEqual(successor);
});

it("drains an in-flight ownership mutation and rejects late attachment during archive", async () => {
  let startArchive: (() => void) | undefined;
  const { lifecycle, values } = createLifecycle(() => {
    startArchive?.();
    startArchive = undefined;
  });
  const update = (key: string, value: string) =>
    lifecycle.withMutation(() => lifecycle.transact(key, () => bindingMutation(value)));
  const { promise: archiveReleased, resolve: releaseArchive } = createDeferred();
  let archive!: Promise<void>;
  startArchive = () => {
    archive = lifecycle.withExclusiveMutationFence(async () => {
      await expect(
        lifecycle.withMutation(() =>
          lifecycle.transact("first", (current) => bindingMutation("updated", current)),
        ),
      ).resolves.toBe(true);
      await archiveReleased;
    });
  };

  await expect(update("first", "before-archive")).resolves.toBe(true);
  await Promise.resolve();
  await expect(update("late", "late")).rejects.toThrow("native archive is in progress");
  releaseArchive();
  await expect(archive).resolves.toBeUndefined();
  expect([...values]).toEqual([["first", { value: "updated" }]]);
});

it("does not let a queued renewal recreate a committed deletion", async () => {
  vi.useFakeTimers();
  const { promise: released, resolve: releaseRenewal } = createDeferred();
  const renewal = vi.fn<() => void | Promise<void>>();
  const { lifecycle, values } = createLifecycle(renewal);
  values.set("binding", { value: "original" });
  await lifecycle.withDeletion("binding", deletion, async (_record, mutation) => {
    try {
      renewal.mockClear().mockImplementationOnce(() => released);
      await vi.advanceTimersByTimeAsync(bindingTestOptions.lease.renewIntervalMs);
      expect(renewal).toHaveBeenCalledOnce();
      mutation.commit();
      expect(values.has("binding")).toBe(false);
    } finally {
      releaseRenewal();
    }
  });
  expect(values.has("binding")).toBe(false);
});
