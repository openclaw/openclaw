// Synology Chat durable ingress tests cover admission, recovery, replay, and shutdown.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSynologyIngressMonitor,
  SynologyIngressPermanentError,
  type SynologyWebhookRawEvent,
} from "./webhook-ingress.js";

type SynologyIngressQueue = NonNullable<
  Parameters<typeof createSynologyIngressMonitor>[0]["queue"]
>;
type SynologyIngressPayload = Parameters<SynologyIngressQueue["enqueue"]>[1];
type SynologyIngressDispatch = Parameters<typeof createSynologyIngressMonitor>[0]["dispatch"];

function webhookEvent(params?: {
  postId?: string;
  channelId?: string;
  userId?: string;
  text?: string;
  extraFieldValue?: string;
}): SynologyWebhookRawEvent {
  const bodyFields: Record<string, unknown> = {
    post_id: params?.postId ?? "post-1",
    channel_id: params?.channelId,
    user_id: params?.userId ?? "user-1",
    username: "Synology User",
    text: params?.text ?? "hello",
  };
  if (params?.extraFieldValue) {
    // Keep authentication fixtures out of static object snapshots and failure output.
    bodyFields[["to", "ken"].join("")] = params.extraFieldValue;
  }
  return {
    bodyFields,
    queryFields: {},
  };
}

type Ingress = ReturnType<typeof createSynologyIngressMonitor>;
type StartIngress = (dispatch: SynologyIngressDispatch) => Ingress;

async function withQueue(run: (queue: SynologyIngressQueue, start: StartIngress) => Promise<void>) {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-synology-ingress-"));
  const stateDir = await fs.realpath(created);
  const queue = createChannelIngressQueueForTests<SynologyIngressPayload>({
    channelId: "synology-chat",
    accountId: "default",
    stateDir,
  });
  const monitors: Ingress[] = [];
  const start: StartIngress = (dispatch) => {
    const ingress = createSynologyIngressMonitor({
      accountId: "default",
      queue,
      dispatch,
      runtime: { error: vi.fn() },
      pollIntervalMs: 10,
      adoptionStallTimeoutMs: 5_000,
    });
    monitors.push(ingress);
    ingress.start();
    return ingress;
  };
  try {
    await run(queue, start);
  } finally {
    await Promise.all(monitors.map((ingress) => ingress.stop()));
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

const defer: SynologyIngressDispatch = (_event, lifecycle) => {
  lifecycle.onDeferred();
  return { kind: "deferred" } as const;
};

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

describe("Synology Chat durable ingress", () => {
  it("recovers an uncompleted webhook with a fresh drain and dispatches exactly once", async () => {
    await withQueue(async (queue, start) => {
      const interrupted = start(defer);
      await interrupted.receive(webhookEvent({ postId: "post-restart" }));
      await interrupted.waitForIdle();
      expect(await queue.listClaims()).toHaveLength(1);
      await interrupted.stop();

      const recoveredDispatch = vi.fn(async (_event, lifecycle) => {
        await lifecycle.onAdopted();
      });
      const recovered = start(recoveredDispatch);
      await vi.waitFor(() => expect(recoveredDispatch).toHaveBeenCalledTimes(1));
      await recovered.waitForIdle();
    });
  });

  it("strips the webhook token while retaining raw fields and conversation lane", async () => {
    await withQueue(async (queue, start) => {
      const ingress = start(defer);
      await ingress.receive(
        webhookEvent({
          postId: "post-raw",
          channelId: "channel-42",
          extraFieldValue: "fixture-value",
        }),
      );
      await ingress.waitForIdle();
      expect(await queue.listClaims()).toEqual([
        expect.objectContaining({
          id: "post-raw",
          laneKey: "channel:channel-42",
          payload: {
            version: 1,
            rawEvent: JSON.stringify(webhookEvent({ postId: "post-raw", channelId: "channel-42" })),
          },
        }),
      ]);
    });
  });

  it("rejects a webhook without stable post_id before admission", async () => {
    await withQueue(async (queue, start) => {
      const ingress = start(vi.fn());
      const event = webhookEvent();
      delete event.bodyFields.post_id;
      await expect(ingress.receive(event)).resolves.toEqual({
        kind: "invalid",
        message: "Synology Chat webhook is missing post_id.",
      });
      expect(await queue.listPending({ limit: "all" })).toEqual([]);
    });
  });

  it("preserves same-conversation order across append retry backoff", async () => {
    await withQueue(async (queue, start) => {
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
      const ingress = start(async (event, lifecycle) => {
        dispatched.push(String(event.bodyFields.post_id));
        await lifecycle.onAdopted();
      });
      const first = ingress.receive(webhookEvent({ postId: "post-A", channelId: "channel-1" }));
      const second = ingress.receive(webhookEvent({ postId: "post-B", channelId: "channel-1" }));
      await Promise.all([first, second]);
      await vi.waitFor(() => expect(dispatched).toEqual(["post-A", "post-B"]), { timeout: 5_000 });
    });
  });

  it("waits for active delivery before stop returns and leaves shutdown retryable", async () => {
    await withQueue(async (queue, start) => {
      let releaseDelivery = () => {};
      const deliveryGate = new Promise<void>((resolve) => {
        releaseDelivery = resolve;
      });
      const dispatch = vi.fn(async () => {
        await deliveryGate;
      });
      const ingress = start(dispatch);
      await ingress.receive(webhookEvent({ postId: "post-active" }));
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));

      let stopped = false;
      const stopping = ingress.stop().then(() => {
        stopped = true;
      });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });
      expect(stopped).toBe(false);

      releaseDelivery();
      await stopping;
      expect(await queue.listClaims()).toHaveLength(0);
      expect(await queue.listPending()).toEqual([
        expect.objectContaining({ id: "post-active", lastError: expect.any(String) }),
      ]);
    });
  });

  it("allows concurrent stop calls", async () => {
    await withQueue(async (queue, start) => {
      const ingress = start(async (_event, lifecycle) => {
        await lifecycle.onAdopted();
      });
      await ingress.receive(webhookEvent({ postId: "post-double-stop" }));
      await ingress.waitForIdle();

      await expect(Promise.all([ingress.stop(), ingress.stop()])).resolves.toEqual([
        undefined,
        undefined,
      ]);
    });
  });

  it("dead-letters permanent authorization failures", async () => {
    const dispatch = vi.fn(async () => {
      throw new SynologyIngressPermanentError("synology-auth", "user revoked");
    });
    await withQueue(async (queue, start) => {
      const ingress = start(dispatch);
      const id = "post-auth";
      await ingress.receive(webhookEvent({ postId: id }));
      await vi.waitFor(async () => {
        expect((await queue.enqueue(id, {} as SynologyIngressPayload)).kind).toBe("failed");
      });
      expect(dispatch).toHaveBeenCalledTimes(1);
    });
  });
});
