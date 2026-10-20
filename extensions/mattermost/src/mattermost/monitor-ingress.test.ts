import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMattermostIngressMonitor } from "./monitor-ingress.js";

type MattermostIngressQueue = NonNullable<
  Parameters<typeof createMattermostIngressMonitor>[0]["queue"]
>;
type MattermostIngressPayload = Parameters<MattermostIngressQueue["enqueue"]>[1];
type MattermostIngressDispatch = Parameters<typeof createMattermostIngressMonitor>[0]["dispatch"];
const adopt: MattermostIngressDispatch = async (_post, _payload, lifecycle) => {
  await lifecycle.onAdopted();
};

function postedEvent(postId = "post-1", event: "posted" | "post_edited" = "posted"): string {
  return JSON.stringify({
    event,
    data: {
      post: JSON.stringify({
        id: postId,
        channel_id: "channel-1",
        user_id: "user-1",
        message: "hello",
      }),
    },
  });
}

let stateDir: string;
let queue: MattermostIngressQueue;
let defaultDispatch: ReturnType<typeof vi.fn<MattermostIngressDispatch>>;
const monitors = new Set<ReturnType<typeof createMattermostIngressMonitor>>();
function startMonitor(
  ingressQueue: MattermostIngressQueue,
  dispatch: MattermostIngressDispatch,
  accountId = "default",
  runtime: Parameters<typeof createMattermostIngressMonitor>[0]["runtime"] = {
    error: vi.fn(),
    log: vi.fn(),
  },
) {
  const monitor = createMattermostIngressMonitor({
    accountId,
    queue: ingressQueue,
    dispatch,
    runtime,
    pollIntervalMs: 60_000,
    adoptionStallTimeoutMs: 5_000,
  });
  monitors.add(monitor);
  const stop = monitor.stop;
  monitor.stop = async () => {
    await stop();
    monitors.delete(monitor);
  };
  return monitor;
}

function createQueue(directory: string, accountId: string): MattermostIngressQueue {
  return createChannelIngressQueueForTests<MattermostIngressPayload>({
    channelId: "mattermost",
    accountId,
    stateDir: directory,
  });
}

function authorlessEvent() {
  return JSON.stringify({
    event: "posted",
    data: {
      post: JSON.stringify({
        id: "post-missing-author",
        channel_id: "channel-1",
        message: "hello",
      }),
    },
    broadcast: { channel_id: "channel-1", user_id: "broadcast-user" },
  });
}
async function expectDeadLetter(ingressQueue: MattermostIngressQueue, id: string) {
  expect((await ingressQueue.enqueue(id, {} as MattermostIngressPayload)).kind).toBe("failed");
}

function failEnqueues(count: number) {
  const failures = { remaining: count };
  const enqueue = queue.enqueue.bind(queue);
  queue.enqueue = async (...args) => {
    if (failures.remaining > 0) {
      failures.remaining--;
      throw new Error("sqlite busy");
    }
    return enqueue(...args);
  };
  return failures;
}
beforeEach(async () => {
  stateDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mattermost-ingress-")),
  );
  queue = createQueue(stateDir, "default");
  defaultDispatch = vi.fn<MattermostIngressDispatch>();
});
afterEach(async () => {
  await Promise.all([...monitors].map((monitor) => monitor.stop()));
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  await fs.rm(stateDir, { recursive: true, force: true });
});

it("visibly rejects an authorless event without disconnecting subsequent ingress", async () => {
  const enqueue = vi.spyOn(queue, "enqueue");
  const runtime = { error: vi.fn(), log: vi.fn() };
  const monitor = startMonitor(queue, defaultDispatch, "default", runtime);
  await monitor.receive(authorlessEvent());
  expect(enqueue).not.toHaveBeenCalled();
  expect(defaultDispatch).not.toHaveBeenCalled();
  expect(runtime.error).toHaveBeenCalledWith(
    expect.stringContaining("Mattermost posted event is missing post.user_id"),
  );

  await monitor.receive(postedEvent("post-after-invalid"));
  await vi.waitFor(() => expect(defaultDispatch).toHaveBeenCalledTimes(1));
});

it("settles only the restarted account and recovers its durable row exactly once", async () => {
  const queueA = createQueue(stateDir, "account-a");
  const queueB = createQueue(stateDir, "account-b");
  const dispatchA = vi.fn<MattermostIngressDispatch>(async (_post, _payload, lifecycle) => {
    lifecycle.onDeferred();
    return { kind: "deferred" } as const;
  });
  const dispatchBBeforeRestart = vi.fn<MattermostIngressDispatch>(async () => undefined);
  const monitorA = startMonitor(queueA, dispatchA, "account-a");
  const monitorBBeforeRestart = startMonitor(queueB, dispatchBBeforeRestart, "account-b");
  const admissionStored = createDeferred<void>();
  const releaseAdmission = createDeferred<void>();
  const enqueueB = queueB.enqueue.bind(queueB);
  queueB.enqueue = async (...args) => {
    const result = await enqueueB(...args);
    admissionStored.resolve();
    await releaseAdmission.promise;
    return result;
  };
  let admittingB: Promise<void> | undefined;
  let stoppingB: Promise<void> | undefined;

  try {
    await Promise.all([monitorA.waitForIdle(), monitorBBeforeRestart.waitForIdle()]);
    const rawEventA = postedEvent("post-account-a");
    await monitorA.receive(rawEventA);
    await monitorA.waitForIdle();
    const claimsABefore = await queueA.listClaims();
    expect(claimsABefore).toEqual([
      expect.objectContaining({
        id: "post-account-a",
        laneKey: "channel:channel-1",
        payload: expect.objectContaining({ rawEvent: rawEventA }),
      }),
    ]);
    expect(dispatchA).toHaveBeenCalledTimes(1);

    admittingB = monitorBBeforeRestart.receive(postedEvent("post-account-b"));
    await admissionStored.promise;
    let stopSettled = false;
    stoppingB = monitorBBeforeRestart.stop().then(() => {
      stopSettled = true;
    });
    await Promise.resolve();

    // Stop must wait for B's append without taking A's live claim.
    expect(stopSettled).toBe(false);
    expect(await queueA.listClaims()).toEqual(claimsABefore);
    expect(dispatchA).toHaveBeenCalledTimes(1);

    releaseAdmission.resolve();
    await Promise.all([admittingB, stoppingB]);
    expect(dispatchBBeforeRestart).not.toHaveBeenCalled();
    expect(await queueB.listPending({ limit: "all" })).toEqual([
      expect.objectContaining({ id: "post-account-b" }),
    ]);
    expect(await queueA.listClaims()).toEqual(claimsABefore);

    const dispatchBAfterRestart = vi.fn<MattermostIngressDispatch>(adopt);
    const monitorBAfterRestart = startMonitor(queueB, dispatchBAfterRestart, "account-b");
    try {
      await monitorBAfterRestart.waitForIdle();
      expect(dispatchBAfterRestart).toHaveBeenCalledTimes(1);
      expect(dispatchBAfterRestart.mock.calls[0]?.[0].id).toBe("post-account-b");

      await monitorBAfterRestart.receive(postedEvent("post-account-b"));
      await monitorBAfterRestart.waitForIdle();
      expect(dispatchBAfterRestart).toHaveBeenCalledTimes(1);
      expect(await queueA.listClaims()).toEqual(claimsABefore);
      expect(dispatchA).toHaveBeenCalledTimes(1);
    } finally {
      await monitorBAfterRestart.stop();
    }
  } finally {
    releaseAdmission.resolve();
    await Promise.allSettled(
      [admittingB, stoppingB].filter((task): task is Promise<void> => task !== undefined),
    );
    await Promise.allSettled([monitorA.stop(), monitorBBeforeRestart.stop()]);
  }
});

it("does not let ignored post_edited events tombstone a later posted event", async () => {
  defaultDispatch.mockImplementation(adopt);
  const monitor = startMonitor(queue, defaultDispatch);
  await monitor.receive(postedEvent("post-edit", "post_edited"));
  await monitor.waitForIdle();
  await monitor.receive(postedEvent("post-edit", "posted"));
  await monitor.waitForIdle();
  expect(defaultDispatch).toHaveBeenCalledTimes(1);
});

it("preserves same-channel arrival order across an append retry backoff", async () => {
  failEnqueues(1);
  const dispatched: string[] = [];
  const ingress = startMonitor(queue, async (post, _payload, lifecycle) => {
    dispatched.push(post.id);
    await lifecycle.onAdopted();
  });
  // A's first append fails into backoff; B arrives concurrently. The
  // admission chain must hold B until A commits, or lane order inverts.
  const admitA = ingress.receive(postedEvent("post-A"));
  const admitB = ingress.receive(postedEvent("post-B"));
  await Promise.all([admitA, admitB]);
  await vi.waitFor(() => expect(dispatched).toEqual(["post-A", "post-B"]), {
    timeout: 5_000,
  });
});

it("never dispatches from a pump racing stop through the async prune", async () => {
  const pruneGate = createDeferred<void>();
  const prune = queue.prune.bind(queue);
  queue.prune = async (...args) => {
    await pruneGate.promise;
    return await prune(...args);
  };
  const ingress = startMonitor(queue, defaultDispatch);
  await ingress.receive(postedEvent("post-stop-race"));

  const stopping = ingress.stop();
  pruneGate.resolve();
  await stopping;

  expect(defaultDispatch).not.toHaveBeenCalled();
});

it("retries a transient append failure and escalates a persistent one", async () => {
  const failures = failEnqueues(2);
  const ingress = startMonitor(queue, defaultDispatch);
  await ingress.receive(postedEvent("post-retry"));
  await ingress.waitForIdle();
  expect(failures.remaining).toBe(0);
  expect(defaultDispatch).toHaveBeenCalledOnce();

  failures.remaining = Number.POSITIVE_INFINITY;
  await expect(ingress.receive(postedEvent("post-lost"))).rejects.toThrow("sqlite busy");
});

it("accepts a post whose channel id arrives at the envelope level", async () => {
  const dispatched: string[] = [];
  const ingress = startMonitor(queue, async (post, _payload, lifecycle) => {
    dispatched.push(post.id);
    await lifecycle.onAdopted();
  });
  await ingress.receive(
    JSON.stringify({
      event: "posted",
      data: {
        channel_id: "channel-envelope",
        post: JSON.stringify({ id: "post-envelope", user_id: "user-1", message: "hi" }),
      },
    }),
  );
  await vi.waitFor(() => expect(dispatched).toEqual(["post-envelope"]));
});

const persist = (id: string, rawEvent: string) =>
  queue.enqueue(
    id,
    { version: 1, receivedAt: 1, rawEvent },
    { receivedAt: 1, laneKey: "channel:channel-1" },
  );

it.each([
  ["malformed JSON", "post-malformed", "{"],
  ["authorless post with broadcast recipient", "post-missing-author", authorlessEvent()],
])("dead-letters persisted %s without retry", async (_name, id, raw) => {
  await persist(id, raw);
  await startMonitor(queue, defaultDispatch).waitForIdle();
  await expectDeadLetter(queue, id);
  expect(defaultDispatch).not.toHaveBeenCalled();
});

it.each([
  ["post-auth", "401 Unauthorized: invalid token", true],
  ["post-transient", "503 Service Unavailable", false],
] as const)(
  "settles %s according to permanent failure classification",
  async (id, failure, permanent) => {
    defaultDispatch.mockImplementation(async () => {
      throw new Error(`Mattermost API ${failure}`);
    });
    const monitor = startMonitor(queue, defaultDispatch);
    await monitor.receive(postedEvent(id));
    await monitor.waitForIdle();
    if (permanent) {
      await expectDeadLetter(queue, id);
    } else {
      expect(await queue.listPending({ limit: "all" })).toEqual([expect.objectContaining({ id })]);
    }
    expect(defaultDispatch).toHaveBeenCalledTimes(1);
  },
);
