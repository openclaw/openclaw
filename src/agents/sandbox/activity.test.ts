import { describe, expect, it, vi } from "vitest";
import {
  acquireSandboxActivity,
  tryAcquireSandboxActivity,
  withSandboxIdleMutation,
} from "./activity.js";

function deferred<T = void>() {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res as typeof resolve;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("sandbox activity coordination", () => {
  it("drains existing activity and blocks later activity during a mutation", async () => {
    const runtimeId = "activity-order";
    const first = await acquireSandboxActivity(runtimeId);
    const second = await acquireSandboxActivity(runtimeId);
    const mutationStarted = deferred();
    const mutationStartedSpy = vi.fn();
    void mutationStarted.promise.then(mutationStartedSpy);
    const finishMutation = deferred();
    const mutation = withSandboxIdleMutation(runtimeId, async () => {
      mutationStarted.resolve();
      await finishMutation.promise;
    });
    const laterActivity = acquireSandboxActivity(runtimeId);
    const laterGranted = vi.fn();
    void laterActivity.then(laterGranted);

    expect(tryAcquireSandboxActivity(runtimeId)).toBeNull();
    first.release();
    await Promise.resolve();
    expect(mutationStartedSpy).not.toHaveBeenCalled();
    second.release();
    await mutationStarted.promise;
    expect(laterGranted).not.toHaveBeenCalled();

    finishMutation.resolve();
    await mutation;
    const later = await laterActivity;
    expect(laterGranted).toHaveBeenCalledOnce();
    later.release();
  });

  it("upgrades one reader before yielding and waits for its peers", async () => {
    const runtimeId = "activity-upgrade";
    const upgrading = await acquireSandboxActivity(runtimeId);
    const peer = await acquireSandboxActivity(runtimeId);
    const upgraded = upgrading.upgradeToMutation();
    const laterActivity = acquireSandboxActivity(runtimeId);
    const laterGranted = vi.fn();
    void laterActivity.then(laterGranted);

    expect(tryAcquireSandboxActivity(runtimeId)).toBeNull();
    peer.release();
    await upgraded;
    expect(laterGranted).not.toHaveBeenCalled();

    upgrading.release();
    const later = await laterActivity;
    expect(laterGranted).toHaveBeenCalledOnce();
    later.release();
  });

  it("removes an aborted activity waiter without blocking the mutation", async () => {
    const runtimeId = "activity-abort";
    const first = await acquireSandboxActivity(runtimeId);
    const finishMutation = deferred();
    const mutation = withSandboxIdleMutation(runtimeId, async () => {
      await finishMutation.promise;
    });
    const controller = new AbortController();
    const queued = acquireSandboxActivity(runtimeId, controller.signal);
    controller.abort();

    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    first.release();
    finishMutation.resolve();
    await mutation;
  });

  it("releases the writer after mutation failure and tolerates duplicate release", async () => {
    const runtimeId = "activity-failure";
    await expect(
      withSandboxIdleMutation(runtimeId, async () => {
        throw new Error("failed mutation");
      }),
    ).rejects.toThrow("failed mutation");

    const lease = await acquireSandboxActivity(runtimeId);
    lease.release();
    lease.release();
    const next = await acquireSandboxActivity(runtimeId);
    next.release();
  });
});
