import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMattermostIngressMonitor } from "./monitor-ingress.js";

type MattermostIngressQueue = NonNullable<
  Parameters<typeof createMattermostIngressMonitor>[0]["queue"]
>;
type MattermostIngressPayload = Parameters<MattermostIngressQueue["enqueue"]>[1];
type MattermostIngressDispatch = Parameters<typeof createMattermostIngressMonitor>[0]["dispatch"];

function postedEvent(params?: {
  postId?: string;
  channelId?: string;
  message?: string;
  event?: "posted" | "post_edited";
}): string {
  return JSON.stringify({
    event: params?.event ?? "posted",
    data: {
      post: JSON.stringify({
        id: params?.postId ?? "post-1",
        channel_id: params?.channelId ?? "channel-1",
        user_id: "user-1",
        message: params?.message ?? "hello",
      }),
    },
  });
}

let stateDir: string;
let queue: MattermostIngressQueue;
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

beforeEach(async () => {
  stateDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mattermost-ingress-")),
  );
  queue = createQueue(stateDir, "default");
});
afterEach(async () => {
  await Promise.all([...monitors].map((monitor) => monitor.stop()));
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  await fs.rm(stateDir, { recursive: true, force: true });
});

describe("Mattermost durable ingress", () => {
  it("visibly rejects an authorless event without disconnecting subsequent ingress", async () => {
    const enqueue = vi.spyOn(queue, "enqueue");
    const dispatch = vi.fn();
    const runtime = { error: vi.fn(), log: vi.fn() };
    const monitor = startMonitor(queue, dispatch, "default", runtime);
    await monitor.receive(authorlessEvent());
    expect(enqueue).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Mattermost posted event is missing post.user_id"),
    );

    await monitor.receive(postedEvent({ postId: "post-after-invalid" }));
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
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
      const rawEventA = postedEvent({ postId: "post-account-a" });
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

      admittingB = monitorBBeforeRestart.receive(postedEvent({ postId: "post-account-b" }));
      await admissionStored.promise;
      let stopSettled = false;
      stoppingB = monitorBBeforeRestart.stop().then(() => {
        stopSettled = true;
      });
      await Promise.resolve();

      // stop() must wait for the serialized append admission. Account A's
      // drain claim and debounce handoff stay owned by its live monitor.
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

      const dispatchBAfterRestart = vi.fn<MattermostIngressDispatch>(
        async (_post, _payload, lifecycle) => {
          await lifecycle.onAdopted();
        },
      );
      const monitorBAfterRestart = startMonitor(queueB, dispatchBAfterRestart, "account-b");
      try {
        await monitorBAfterRestart.waitForIdle();
        expect(dispatchBAfterRestart).toHaveBeenCalledTimes(1);
        expect(dispatchBAfterRestart.mock.calls[0]?.[0].id).toBe("post-account-b");

        await monitorBAfterRestart.receive(postedEvent({ postId: "post-account-b" }));
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
    const dispatch = vi.fn(async (_post, _payload, lifecycle) => {
      await lifecycle.onAdopted();
    });
    const monitor = startMonitor(queue, dispatch);
    await monitor.receive(postedEvent({ postId: "post-edit", event: "post_edited" }));
    await monitor.waitForIdle();
    await monitor.receive(postedEvent({ postId: "post-edit", event: "posted" }));
    await monitor.waitForIdle();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("preserves same-channel arrival order across an append retry backoff", async () => {
    let failFirst = true;
    const enqueue = queue.enqueue.bind(queue);
    queue.enqueue = async (...args) => {
      if (failFirst) {
        failFirst = false;
        throw new Error("sqlite busy");
      }
      return await enqueue(...args);
    };
    const dispatched: string[] = [];
    const ingress = startMonitor(queue, async (post, _payload, lifecycle) => {
      dispatched.push(post.id);
      await lifecycle.onAdopted();
    });
    // A's first append fails into backoff; B arrives concurrently. The
    // admission chain must hold B until A commits, or lane order inverts.
    const admitA = ingress.receive(postedEvent({ postId: "post-A" }));
    const admitB = ingress.receive(postedEvent({ postId: "post-B" }));
    await Promise.all([admitA, admitB]);
    await vi.waitFor(() => expect(dispatched).toEqual(["post-A", "post-B"]), {
      timeout: 5_000,
    });
  });

  it("never dispatches from a pump racing stop through the async prune", async () => {
    let releasePrune = () => {};
    const pruneGate = new Promise<void>((resolve) => {
      releasePrune = resolve;
    });
    const prune = queue.prune.bind(queue);
    queue.prune = async (...args) => {
      await pruneGate;
      return await prune(...args);
    };
    const dispatch = vi.fn();
    const ingress = startMonitor(queue, dispatch);
    await ingress.receive(postedEvent({ postId: "post-stop-race" }));

    const stopping = ingress.stop();
    releasePrune();
    await stopping;

    expect(dispatch).not.toHaveBeenCalled();
  });

  it("retries a transient append failure and escalates a persistent one", async () => {
    let failures = 2;
    const enqueue = queue.enqueue.bind(queue);
    queue.enqueue = async (...args) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("sqlite busy");
      }
      return await enqueue(...args);
    };
    const dispatch = vi.fn();
    const ingress = startMonitor(queue, dispatch);
    // Two transient failures absorb into the bounded retry.
    await ingress.receive(postedEvent({ postId: "post-retry" }));
    await ingress.waitForIdle();
    expect(failures).toBe(0);
    expect(dispatch).toHaveBeenCalledOnce();

    // A persistent failure escalates so the websocket can tear down loudly.
    failures = Number.POSITIVE_INFINITY;
    await expect(ingress.receive(postedEvent({ postId: "post-lost" }))).rejects.toThrow(
      "sqlite busy",
    );
  });

  it("accepts a post whose channel id arrives at the envelope level", async () => {
    const dispatched: string[] = [];
    const ingress = startMonitor(queue, async (post, _payload, lifecycle) => {
      dispatched.push(post.id);
      await lifecycle.onAdopted();
    });
    // The monitor dispatch honors post/data/broadcast channel ids; the
    // durable inspector must not reject the envelope-level shapes.
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

  it("dead-letters malformed persisted payloads without retry", async () => {
    await queue.enqueue(
      "post-malformed",
      { version: 1, receivedAt: 1, rawEvent: "{" },
      { receivedAt: 1, laneKey: "channel:channel-1" },
    );
    const dispatch = vi.fn();
    const monitor = startMonitor(queue, dispatch);
    await monitor.waitForIdle();
    await expectDeadLetter(queue, "post-malformed");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("dead-letters a persisted authorless post without using broadcast recipient identity", async () => {
    await queue.enqueue(
      "post-missing-author",
      {
        version: 1,
        receivedAt: 1,
        rawEvent: authorlessEvent(),
      },
      { receivedAt: 1, laneKey: "channel:channel-1" },
    );
    const dispatch = vi.fn();
    const monitor = startMonitor(queue, dispatch);
    await monitor.waitForIdle();
    await expectDeadLetter(queue, "post-missing-author");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("dead-letters permanent Mattermost auth failures", async () => {
    const dispatch = vi.fn(async () => {
      throw new Error("Mattermost API 401 Unauthorized: invalid token");
    });
    const monitor = startMonitor(queue, dispatch);
    await monitor.receive(postedEvent({ postId: "post-auth" }));
    await monitor.waitForIdle();
    await expectDeadLetter(queue, "post-auth");
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("leaves transient Mattermost failures retryable", async () => {
    const dispatch = vi.fn(async () => {
      throw new Error("Mattermost API 503 Service Unavailable");
    });
    const monitor = startMonitor(queue, dispatch);
    await monitor.receive(postedEvent({ postId: "post-transient" }));
    await monitor.waitForIdle();
    expect(await queue.listPending({ limit: "all" })).toEqual([
      expect.objectContaining({ id: "post-transient" }),
    ]);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
