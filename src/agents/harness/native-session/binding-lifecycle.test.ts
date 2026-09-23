import { describe, expect, it } from "vitest";
import { createNativeSessionBindingLifecycle } from "./binding-lifecycle.js";
import {
  bindingTestOptions,
  createBindingTestState,
  prepareBindingTestLease,
} from "./binding.test-support.js";

describe("native session binding lifecycle", () => {
  it("deletes only the requested owner and restores it on transaction rollback", async () => {
    const { state, values } = createBindingTestState();
    const lifecycle = createNativeSessionBindingLifecycle(state, bindingTestOptions);
    const original = { value: "run" };
    values.set("base", { value: "base" });
    values.set("run", original);
    const deletion = {
      prepareLease: prepareBindingTestLease,
      assertCurrent: () => {},
      assertRecordCurrent: () => {},
    };

    await lifecycle.withDeletion("run", deletion, async (_record, mutation) => {
      mutation.commit();
      expect(values.get("run")).toBeUndefined();
      expect(values.get("base")).toEqual({ value: "base" });
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
    const { state, values } = createBindingTestState();
    const lifecycle = createNativeSessionBindingLifecycle(state, bindingTestOptions);
    const key = "binding-owner";
    values.set(key, { value: "owner" });
    let active = true;

    await expect(
      lifecycle.withDeletion(
        key,
        {
          prepareLease: prepareBindingTestLease,
          assertCurrent: () => {
            if (!active) {
              throw new Error("owner revoked");
            }
          },
          assertRecordCurrent: () => {},
        },
        async (_record, mutation) => {
          active = false;
          expect(mutation.commit).toThrow("owner revoked");
        },
      ),
    ).rejects.toThrow("owner revoked");
    expect(values.get(key)).toMatchObject({ value: "owner" });

    // Revocation leaves the bounded lease for expiry; the successor is an independent owner.
    const successor = { value: "successor" };
    values.set(key, successor);
    await lifecycle.withDeletion(
      key,
      {
        prepareLease: prepareBindingTestLease,
        assertCurrent: () => {},
        assertRecordCurrent: () => {},
      },
      async (_record, mutation) => {
        mutation.commit();
        values.set(key, successor);
        expect(mutation.rollback).toThrow("changed before session deletion rollback");
      },
    );
    expect(values.get(key)).toEqual(successor);
  });

  it("drains an in-flight ownership mutation and rejects late attachment during archive", async () => {
    const { state, values } = createBindingTestState();
    const originalUpdate = state.update!.bind(state);
    let startArchive: (() => void) | undefined;
    state.update = (...args) => {
      startArchive?.();
      startArchive = undefined;
      return originalUpdate(...args);
    };
    const lifecycle = createNativeSessionBindingLifecycle(state, bindingTestOptions);
    let releaseArchive!: () => void;
    const archiveReleased = new Promise<void>((resolve) => {
      releaseArchive = resolve;
    });
    let archive!: Promise<void>;
    startArchive = () => {
      archive = lifecycle.withExclusiveMutationFence(async () => {
        await expect(
          lifecycle.withMutation(() =>
            lifecycle.transact("first", (current) => ({
              next: { ...current, value: "updated" },
              result: true,
            })),
          ),
        ).resolves.toBe(true);
        await archiveReleased;
      });
    };

    await expect(
      lifecycle.withMutation(() =>
        lifecycle.transact("first", () => ({
          next: { value: "before-archive" },
          result: true,
        })),
      ),
    ).resolves.toBe(true);
    await Promise.resolve();
    await expect(
      lifecycle.withMutation(() =>
        lifecycle.transact("late", () => ({
          next: { value: "late" },
          result: true,
        })),
      ),
    ).rejects.toThrow("native archive is in progress");
    releaseArchive();
    await expect(archive).resolves.toBeUndefined();
    expect(values.get("first")).toEqual({ value: "updated" });
    expect(values.get("late")).toBeUndefined();
  });
});
