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

type SynologyIngressPayload = { version: 1; rawEvent: string };
type SynologyIngressQueue = ReturnType<
  typeof createChannelIngressQueueForTests<SynologyIngressPayload>
>;
type SynologyIngressDispatch = Parameters<typeof createSynologyIngressMonitor>[0]["dispatch"];

const { openChannelIngressQueue } = vi.hoisted(() => ({ openChannelIngressQueue: vi.fn() }));
vi.mock("./runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime.js")>()),
  getSynologyRuntime: () => ({ state: { openChannelIngressQueue } }),
}));

function webhookEvent(
  postId = "post-1",
  channelId?: string,
  extraFieldValue?: string,
): SynologyWebhookRawEvent {
  const bodyFields: Record<string, unknown> = {
    post_id: postId,
    channel_id: channelId,
    user_id: "user-1",
    username: "Synology User",
    text: "hello",
  };
  if (extraFieldValue) {
    // Keep authentication fixtures out of static object snapshots and failure output.
    bodyFields[["to", "ken"].join("")] = extraFieldValue;
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
    openChannelIngressQueue.mockReturnValue(queue);
    const ingress = createSynologyIngressMonitor({
      accountId: "default",
      dispatch,
      runtime: { error: vi.fn() },
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
  it("redacts and persists raw webhook fields, then recovers them exactly once", async () => {
    await withQueue(async (queue, start) => {
      const interrupted = start(defer);
      const event = webhookEvent("post-raw", "channel-42");
      await interrupted.receive(webhookEvent("post-raw", "channel-42", "fixture-value"));
      await interrupted.waitForIdle();
      expect(await queue.listClaims()).toEqual([
        expect.objectContaining({
          id: "post-raw",
          laneKey: "channel:channel-42",
          payload: { version: 1, rawEvent: JSON.stringify(event) },
        }),
      ]);
      await expect(Promise.all([interrupted.stop(), interrupted.stop()])).resolves.toEqual([
        undefined,
        undefined,
      ]);
      const recoveredDispatch = vi.fn(async (_event, lifecycle) => {
        await lifecycle.onAdopted();
      });
      const recovered = start(recoveredDispatch);
      await vi.waitFor(() => expect(recoveredDispatch).toHaveBeenCalledTimes(1));
      await recovered.waitForIdle();
      expect(recoveredDispatch.mock.calls[0]?.[0]).toEqual(event);
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

  it("dead-letters permanent authorization failures", async () => {
    const dispatch = vi.fn(async () => {
      throw new SynologyIngressPermanentError("synology-auth", "user revoked");
    });
    await withQueue(async (queue, start) => {
      const ingress = start(dispatch);
      const id = "post-auth";
      await ingress.receive(webhookEvent(id));
      await vi.waitFor(async () => {
        expect((await queue.enqueue(id, {} as SynologyIngressPayload)).kind).toBe("failed");
      });
      expect(dispatch).toHaveBeenCalledTimes(1);
    });
  });
});
