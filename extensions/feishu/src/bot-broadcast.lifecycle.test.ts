import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi } from "vitest";
import { createFeishuBroadcastIngressSettlement } from "./bot-broadcast.js";

it("joins an admitted lane commit after broadcast failure and retires late adoption", async () => {
  const started = createDeferred<void>();
  const commitGate = createDeferred<void>();
  const lateCommit = vi.fn(async () => true);
  let completion: Promise<void> | undefined;
  let settled = false;
  const broadcast = createFeishuBroadcastIngressSettlement({
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
    release: vi.fn(),
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
    await failing.onDispatchFailed(new Error("another lane failed"));
    await late.lifecycle.onAdopted();
    expect(late.lifecycle.abortSignal.aborted).toBe(true);
    expect(lateCommit).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(settled).toBe(false);
  } finally {
    commitGate.resolve();
    await adoption;
    await completion;
  }
  expect(settled).toBe(true);
});
