import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createChannelReplayGuard } from "openclaw/plugin-sdk/persistent-dedupe";
import { expect, it, vi } from "vitest";
import { createFeishuBroadcastIngressSettlement } from "./bot-broadcast.js";

it.each([
  ["cancelled", "abandoned"],
  ["abandoned", "cancelled"],
  ["cancelled", "dispatch-failed"],
  ["cancelled", "cancelled"],
  ["cancelled", "adopted"],
] as const)("settles broadcast custody when deferred lanes are %s then %s", async (first, last) => {
  const onAbandoned = vi.fn();
  const onCancelled = vi.fn();
  const broadcast = createFeishuBroadcastIngressSettlement({
    lifecycle: {
      abortSignal: new AbortController().signal,
      onAdopted: vi.fn(),
      onDeferred: vi.fn(),
      onAdoptionFinalizing: vi.fn(),
      onAbandoned,
      onCancelled,
    },
  });
  const release = vi.fn();
  const firstLane = broadcast.createLane({ keys: ["first-lane"], commit: vi.fn(), release });
  const peer = broadcast.createLane();
  firstLane.lifecycle.onDeferred();
  peer.lifecycle.onDeferred();
  await broadcast.onDispatchComplete();
  if (first === "cancelled") {
    await firstLane.lifecycle.onCancelled?.();
    expect(onCancelled).not.toHaveBeenCalled();
  } else {
    await firstLane.lifecycle.onAbandoned();
  }
  expect(release).toHaveBeenCalledOnce();
  switch (last) {
    case "cancelled":
      await peer.lifecycle.onCancelled?.();
      break;
    case "abandoned":
      await peer.lifecycle.onAbandoned();
      break;
    case "dispatch-failed":
      await peer.onDispatchFailed(new Error("dispatch failed"));
      break;
    case "adopted":
      await peer.lifecycle.onAdopted();
      break;
  }
  const genuineFailure =
    first === "abandoned" || last === "abandoned" || last === "dispatch-failed";
  expect(onAbandoned).toHaveBeenCalledTimes(genuineFailure ? 1 : 0);
  expect(onCancelled).toHaveBeenCalledTimes(genuineFailure ? 0 : 1);
});

it("releases dropped lanes independently while retaining admitted broadcast custody", async () => {
  const started = createDeferred<void>();
  const commitGate = createDeferred<void>();
  const abandonmentGate = createDeferred<void>();
  const abortController = new AbortController();
  const replay = createChannelReplayGuard<string>({
    dedupe: { ttlMs: 1_000, memoryMaxSize: 10 },
    buildReplayKey: (key) => key,
  });
  const lateClaim = await replay.claim("late-lane");
  if (lateClaim.kind !== "claimed") {
    throw new Error("expected a fresh replay claim");
  }
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
      onDropped: vi.fn(),
      onAbandoned: async () => {
        abortController.abort();
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
  const dropped = broadcast.createLane();
  const late = broadcast.createLane({
    ...lateClaim.handle,
    commit: lateCommit,
  });
  for (const lane of [adopting, failing, dropped, late]) {
    lane.lifecycle.onDeferred();
  }
  const droppedOutcome = Promise.resolve(dropped.lifecycle.onDropped?.("queue-cap-old")).catch(
    (error: unknown) => error,
  );
  const failure = new Error("another lane failed");
  await broadcast.onDispatchComplete();
  const adoption = adopting.lifecycle.onAdopted();
  try {
    await started.promise;
    await adopting.lifecycle.onAbandoned();
    await adopting.onDispatchComplete(true);
    expect(release).not.toHaveBeenCalled();
    abandonment = failing.onDispatchFailed(failure);
    await late.lifecycle.onAdopted();
    expect(late.lifecycle.abortSignal.aborted).toBe(true);
    expect(lateCommit).not.toHaveBeenCalled();
    expect(await droppedOutcome).toBeUndefined();
    await expect(late.lifecycle.onDropped?.("queue-cap-new")).rejects.toBe(failure);
    const retry = await replay.claim("late-lane");
    expect(retry.kind).toBe("claimed");
    if (retry.kind === "claimed") {
      retry.handle.release();
    }
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
});
