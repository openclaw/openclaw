import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi } from "vitest";
import { createFeishuBroadcastIngressSettlement } from "./bot-broadcast.js";

it("joins an admitted lane commit after broadcast failure and retires late adoption", async () => {
  const started = createDeferred<void>();
  const commitGate = createDeferred<void>();
  const abandonmentStarted = createDeferred<void>();
  const abandonmentGate = createDeferred<void>();
  const abortController = new AbortController();
  const lateCommit = vi.fn(async () => true);
  let completion: Promise<void> | undefined;
  let settled = false;
  let abandonment: Promise<void> | undefined;
  const release = vi.fn();
  const broadcast = createFeishuBroadcastIngressSettlement({
    lifecycle: {
      abortSignal: abortController.signal,
      onAdopted: vi.fn(async () => {}),
      onDeferred: vi.fn(),
      onAdoptionFinalizing: vi.fn(),
      onAbandoned: async () => {
        abortController.abort();
        abandonmentStarted.resolve();
        await abandonmentGate.promise;
      },
    },
    trackTask: (task) => {
      completion = task.then(() => {
        settled = true;
      });
    },
  });
  const adopting = broadcast.createLane({
    keys: ["admitted-lane"],
    commit: async () => {
      started.resolve();
      await commitGate.promise;
      return true;
    },
    release,
  });
  const failing = broadcast.createLane();
  const late = broadcast.createLane({
    keys: ["late-lane"],
    commit: lateCommit,
    release: vi.fn(),
  });
  adopting.lifecycle.onDeferred();
  failing.lifecycle.onDeferred();
  late.lifecycle.onDeferred();
  await broadcast.onDispatchComplete();
  const adoption = adopting.lifecycle.onAdopted();
  try {
    await started.promise;
    await adopting.lifecycle.onAbandoned();
    await adopting.onDispatchComplete(true);
    expect(release).not.toHaveBeenCalled();
    abandonment = failing.onDispatchFailed(new Error("another lane failed"));
    await abandonmentStarted.promise;
    await late.lifecycle.onAdopted();
    expect(late.lifecycle.abortSignal.aborted).toBe(true);
    expect(lateCommit).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(settled).toBe(false);
    commitGate.resolve();
    await adoption;
    expect(settled).toBe(false);
  } finally {
    commitGate.resolve();
    abandonmentGate.resolve();
    await adoption;
    await abandonment;
    await completion;
  }
  expect(settled).toBe(true);
});
