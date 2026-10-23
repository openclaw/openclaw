import crypto from "node:crypto";
import type { webhook } from "@line/bot-sdk";
import {
  closeOpenClawStateDatabaseForTest,
  observeChannelIngressQueueWrite,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import * as channelOutbound from "openclaw/plugin-sdk/channel-outbound";
import type { ChannelIngressQueue } from "openclaw/plugin-sdk/channel-outbound";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createMockIncomingRequest, createMockServerResponse } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLineNodeWebhookHandler } from "./webhook-node.js";
import {
  createLineWebhookSpool,
  LineWebhookTerminalDeliveryError,
  type LineWebhookTurnAdoptionLifecycle,
} from "./webhook-spool.js";
import {
  callback,
  createEvent,
  payloadFor,
  runtime,
  type SpoolPayload,
  waitForVerdict,
  withQueue,
} from "./webhook-spool.test-support.js";
type Deliver = Parameters<typeof createLineWebhookSpool>[0]["deliver"];
const adopt: Deliver = async (_events, _destination, control) => {
  await control.turnAdoptionLifecycle.onAdopted();
};
function createSpool(
  queue: ChannelIngressQueue<SpoolPayload>,
  deliver: Deliver,
  runtimeEnv = runtime(),
) {
  return createLineWebhookSpool({ accountId: "default", runtime: runtimeEnv, queue, deliver });
}
function observeActiveDeliveryStopGrace(spool: ReturnType<typeof createSpool>) {
  vi.useFakeTimers();
  const armed = createDeferred<void>();
  const schedule = globalThis.setTimeout;
  const timeout = vi
    .spyOn(globalThis, "setTimeout")
    .mockImplementation((onTimeout, delay, ...args) => {
      const timer = schedule.call(globalThis, onTimeout, delay, ...args);
      if (delay === 5_000) {
        armed.resolve();
      }
      return timer;
    });
  let settled = false;
  const stopping = spool.stop().then(() => {
    settled = true;
  });
  return {
    armed: armed.promise,
    stopping,
    isSettled: () => settled,
    restore: () => timeout.mockRestore(),
  };
}
function acceptEvent(
  spool: ReturnType<typeof createLineWebhookSpool>,
  event: Parameters<typeof createEvent>[0],
) {
  return spool.accept(callback(createEvent(event)));
}
describe("LINE webhook spool", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });
  it("does not acknowledge when durable enqueue fails", async () => {
    await withQueue(async (queue) => {
      const enqueue = vi.fn(async () => {
        throw new Error("sqlite unavailable");
      });
      const failingQueue: ChannelIngressQueue<SpoolPayload> = { ...queue, enqueue };
      const deliver = vi.fn(async () => {});
      const spool = createSpool(failingQueue, deliver);
      const body = JSON.stringify(callback(createEvent({ webhookEventId: "event-ack-fail" })));
      const channelSecret = "test-channel-secret";
      const handler = createLineNodeWebhookHandler({
        getTargets: () => [{ channelSecret, bot: { handleWebhook: spool.accept } }],
        runtime: runtime(),
      });
      try {
        const response = createMockServerResponse();
        response.statusCode = 0;
        await handler(
          Object.assign(createMockIncomingRequest([body]), {
            method: "POST",
            headers: {
              "x-line-signature": crypto
                .createHmac("SHA256", channelSecret)
                .update(body)
                .digest("base64"),
            },
          }),
          response,
        );
        expect(response.statusCode).toBe(500);
        expect(enqueue).toHaveBeenCalledTimes(1);
        expect(deliver).not.toHaveBeenCalled();
      } finally {
        await spool.stop();
      }
    });
  });
  it("caps active deliveries across repeated drain pumps", async () => {
    await withQueue(async (queue) => {
      const deliveryGate = createDeferred<void>();
      let activeDeliveries = 0;
      let maxActiveDeliveries = 0;
      const deliver = vi.fn(async (_event, _destination, control) => {
        activeDeliveries += 1;
        maxActiveDeliveries = Math.max(maxActiveDeliveries, activeDeliveries);
        await control.turnAdoptionLifecycle.onAdopted();
        try {
          await deliveryGate.promise;
        } finally {
          activeDeliveries -= 1;
        }
      });
      const factory = vi.spyOn(channelOutbound, "createChannelIngressMonitor");
      let spool: ReturnType<typeof createSpool>;
      let monitor: ReturnType<typeof channelOutbound.createChannelIngressMonitor>;
      try {
        spool = createSpool(queue, deliver);
        const result = factory.mock.results[0];
        if (result?.type !== "return") {
          throw new Error("LINE spool did not create its ingress monitor");
        }
        monitor = result.value;
      } finally {
        factory.mockRestore();
      }
      const firstBatch = Array.from({ length: 8 }, (_, index) =>
        createEvent({
          webhookEventId: `event-concurrency-${index}`,
          userId: `user-${index}`,
        }),
      );
      const ninth = createEvent({ webhookEventId: "event-concurrency-8", userId: "user-8" });
      spool.start();
      try {
        await spool.accept({ destination: "destination-1", events: firstBatch });
        await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(8));
        await monitor.waitForPumpIdle();
        await spool.accept(callback(ninth));
        await monitor.waitForPumpIdle();
        expect(deliver).toHaveBeenCalledTimes(8);
        expect(maxActiveDeliveries).toBe(8);
        expect(await queue.listPending()).toMatchObject([
          { id: "message:message-event-concurrency-8", laneKey: "user:user-8" },
        ]);
        deliveryGate.resolve();
        await vi.waitFor(() => expect(activeDeliveries).toBe(0));
        await spool.accept(callback(ninth));
        await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(9));
        expect(maxActiveDeliveries).toBe(8);
      } finally {
        deliveryGate.resolve();
        await spool.stop();
      }
    });
  });
  it("waits for active delivery before releasing its claim on stop", async () => {
    await withQueue(async (queue) => {
      const deliveryGate = createDeferred<void>();
      const firstDeliver = vi.fn(async () => {
        await deliveryGate.promise;
      });
      const first = createSpool(queue, firstDeliver);
      const event = createEvent({ webhookEventId: "event-stop-active" });
      first.start();
      await first.accept(callback(event));
      await vi.waitFor(() => expect(firstDeliver).toHaveBeenCalledTimes(1));
      let stopSettled = false;
      const firstStop = first.stop();
      const secondStop = first.stop();
      expect(secondStop).toBe(firstStop);
      const stopping = firstStop.then(() => {
        stopSettled = true;
      });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });
      expect(stopSettled).toBe(false);
      expect(await queue.listClaims()).toHaveLength(1);
      deliveryGate.resolve();
      await stopping;
      const restartedDeliver = vi.fn(adopt);
      const restarted = createSpool(queue, restartedDeliver);
      restarted.start();
      try {
        await waitForVerdict(queue, "message:message-event-stop-active", "completed");
        expect(restartedDeliver).toHaveBeenCalledTimes(1);
      } finally {
        await restarted.stop();
      }
    });
  });
  it("disposes after the active-delivery stop grace expires", async () => {
    await withQueue(async (queue) => {
      const deliveryGate = createDeferred<void>();
      const deliveryStarted = createDeferred<LineWebhookTurnAdoptionLifecycle>();
      let lateLifecycle: LineWebhookTurnAdoptionLifecycle | undefined;
      const firstDeliver = vi.fn<Deliver>(async (_events, _destination, control) => {
        deliveryStarted.resolve(control.turnAdoptionLifecycle);
        await deliveryGate.promise;
      });
      const firstRuntime = runtime();
      const first = createSpool(queue, firstDeliver, firstRuntime);
      const event = createEvent({ webhookEventId: "event-stop-timeout" });
      let grace: ReturnType<typeof observeActiveDeliveryStopGrace> | undefined;
      let restarted: ReturnType<typeof createLineWebhookSpool> | undefined;
      try {
        first.start();
        await first.accept(callback(event));
        lateLifecycle = await deliveryStarted.promise;
        expect(firstDeliver).toHaveBeenCalledTimes(1);
        grace = observeActiveDeliveryStopGrace(first);
        const stop = grace;
        await stop.armed;
        await vi.advanceTimersByTimeAsync(4_999);
        expect(stop.isSettled()).toBe(false);
        expect(lateLifecycle?.abortSignal.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await stop.stopping;
        expect(firstRuntime.log).toHaveBeenCalledWith(
          expect.stringContaining("timed out after 5000ms"),
        );
        expect(lateLifecycle.abortSignal.aborted).toBe(true);
        grace.restore();
        grace = undefined;
        vi.useRealTimers();
        const released = observeChannelIngressQueueWrite(queue, "release");
        lateLifecycle.onDeferred();
        await expect(released).resolves.toBe(true);
        expect(await queue.listClaims()).toEqual([]);
        const replayCompleted = observeChannelIngressQueueWrite(queue, "complete");
        const restartedDeliver = vi.fn(adopt);
        restarted = createSpool(queue, restartedDeliver);
        restarted.start();
        await expect(replayCompleted).resolves.toBe(true);
        await expect(
          queue.enqueue("message:message-event-stop-timeout", payloadFor(event)),
        ).resolves.toMatchObject({ kind: "completed" });
        expect(restartedDeliver).toHaveBeenCalledTimes(1);
      } finally {
        grace?.restore();
        vi.useRealTimers();
        deliveryGate.resolve();
        await lateLifecycle?.onAbandoned();
        await first.stop();
        await restarted?.stop();
      }
    });
  });
  it("waits for claims deferred after an active-delivery stop timeout", async () => {
    await withQueue(async (queue) => {
      const deliveryGate = createDeferred<void>();
      const deliveriesStarted = createDeferred<void>();
      let deferredLifecycle: LineWebhookTurnAdoptionLifecycle | undefined;
      let activeLifecycle: LineWebhookTurnAdoptionLifecycle | undefined;
      const spoolRuntime = runtime();
      const deliver = vi.fn<Deliver>(async (events, _destination, control) => {
        if ((events[0] as webhook.MessageEvent).message.id === "message-event-stop-deferred") {
          deferredLifecycle = control.turnAdoptionLifecycle;
          control.turnAdoptionLifecycle.onDeferred();
          if (activeLifecycle) {
            deliveriesStarted.resolve();
          }
          return;
        }
        activeLifecycle = control.turnAdoptionLifecycle;
        if (deferredLifecycle) {
          deliveriesStarted.resolve();
        }
        await deliveryGate.promise;
      });
      const spool = createSpool(queue, deliver, spoolRuntime);
      let grace: ReturnType<typeof observeActiveDeliveryStopGrace> | undefined;
      try {
        spool.start();
        await acceptEvent(spool, { webhookEventId: "event-stop-active" });
        await acceptEvent(spool, { webhookEventId: "event-stop-deferred", userId: "user-2" });
        await deliveriesStarted.promise;
        expect(deliver).toHaveBeenCalledTimes(2);
        grace = observeActiveDeliveryStopGrace(spool);
        const stop = grace;
        await stop.armed;
        await vi.advanceTimersByTimeAsync(5_000);
        expect(spoolRuntime.log).toHaveBeenCalledWith(
          expect.stringContaining("timed out after 5000ms"),
        );
        expect(stop.isSettled()).toBe(false);
        grace.restore();
        grace = undefined;
        vi.useRealTimers();
        if (!deferredLifecycle || !activeLifecycle) {
          throw new Error("LINE deliveries did not expose their adoption lifecycles");
        }
        activeLifecycle.onDeferred();
        await deferredLifecycle.onAbandoned();
        expect(stop.isSettled()).toBe(false);
        await activeLifecycle.onAbandoned();
        deliveryGate.resolve();
        await stop.stopping;
        expect(stop.isSettled()).toBe(true);
        expect(await queue.listClaims()).toEqual([]);
      } finally {
        grace?.restore();
        vi.useRealTimers();
        deliveryGate.resolve();
        await Promise.allSettled([
          deferredLifecycle?.onAbandoned(),
          activeLifecycle?.onAbandoned(),
        ]);
        await spool.stop();
      }
    });
  });
  it("deduplicates a redelivered message id even when webhookEventId changes", async () => {
    await withQueue(async (queue) => {
      const enqueue = vi.spyOn(queue, "enqueue");
      const deliver = vi.fn(adopt);
      const spool = createSpool(queue, deliver);
      spool.start();
      try {
        await acceptEvent(spool, { webhookEventId: "delivery-a", messageId: "shared-message" });
        await waitForVerdict(queue, "message:shared-message", "completed");
        await acceptEvent(spool, { webhookEventId: "delivery-b", messageId: "shared-message" });
        await expect(enqueue.mock.results.at(-1)?.value).resolves.toMatchObject({
          kind: "completed",
          duplicate: true,
        });
        expect(deliver).toHaveBeenCalledTimes(1);
      } finally {
        await spool.stop();
      }
    });
  });
  it.each([
    ["invalid-event", undefined, 0, "{"],
    ["retry-limit-exceeded", new Error("persistent transient failure"), 7, undefined],
    [
      "authentication-failed",
      Object.assign(new Error("invalid channel access token"), { status: 401 }),
      0,
      undefined,
    ],
    [
      "delivery-side-effects-committed",
      new LineWebhookTerminalDeliveryError("reply token consumed"),
      0,
      undefined,
    ],
  ] as const)(
    "dead-letters %s without another attempt",
    async (reason, error, priorAttempts, rawEvent) => {
      await withQueue(async (queue) => {
        const event = createEvent({ webhookEventId: "event-failure" });
        const eventId = "message:message-event-failure";
        const stored = rawEvent !== undefined || priorAttempts > 0;
        if (stored) {
          await queue.enqueue(
            eventId,
            { ...payloadFor(event), ...(rawEvent === undefined ? {} : { rawEvent }) },
            { laneKey: "user:user-1" },
          );
        }
        for (let attempt = 0; attempt < priorAttempts; attempt += 1) {
          const claim = await queue.claim(eventId);
          if (!claim) {
            throw new Error(`failed to seed LINE retry attempt ${attempt + 1}`);
          }
          await queue.release(claim, {
            lastError: "seeded transient failure",
            releasedAt: Date.now() - 4 * 60_000,
          });
        }
        const deliver = vi.fn(async () => {
          if (error) {
            throw error;
          }
        });
        const spool = createSpool(queue, deliver);
        spool.start();
        try {
          if (!stored) {
            await spool.accept(callback(event));
          }
          await waitForVerdict(queue, eventId, "failed");
          expect(deliver).toHaveBeenCalledTimes(rawEvent === undefined ? 1 : 0);
          expect(await queue.enqueue(eventId, payloadFor(event))).toMatchObject({
            kind: "failed",
            record: { reason },
          });
        } finally {
          await spool.stop();
        }
      });
    },
  );
});
