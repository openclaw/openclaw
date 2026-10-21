import type { webhook } from "@line/bot-sdk";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import * as imageSetIngress from "./inbound-image-set.js";
import { createLineWebhookSpool } from "./webhook-spool.js";
import { callback, createEvent, runtime, withQueue } from "./webhook-spool.test-support.js";
type SpoolOptions = Parameters<typeof createLineWebhookSpool>[0];
type Deliver = SpoolOptions["deliver"];
function createSpool(queue: NonNullable<SpoolOptions["queue"]>, deliver: Deliver) {
  return createLineWebhookSpool({ accountId: "default", runtime: runtime(), queue, deliver });
}
function createImageSetClockSpool(
  queue: NonNullable<SpoolOptions["queue"]>,
  deliver: Deliver,
  runtimeEnv = runtime(),
) {
  const factory = vi.spyOn(imageSetIngress, "createLineImageSetIngressBuffer");
  let spool: ReturnType<typeof createLineWebhookSpool>;
  let buffer: ReturnType<typeof imageSetIngress.createLineImageSetIngressBuffer>;
  try {
    spool = createLineWebhookSpool({ accountId: "default", runtime: runtimeEnv, queue, deliver });
    const result = factory.mock.results[0];
    if (result?.type !== "return") {
      throw new Error("LINE spool did not create its image-set buffer");
    }
    buffer = result.value;
  } finally {
    factory.mockRestore();
  }
  const admit = vi.spyOn(buffer, "admit");
  const enterLane = vi.spyOn(buffer, "enterLane");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const timeouts = vi.spyOn(globalThis, "setTimeout");
  const clearedTimeouts = vi.spyOn(globalThis, "clearTimeout");
  const hasPendingFlush = () => {
    const cleared = new Set(clearedTimeouts.mock.calls.map(([timer]) => timer));
    return timeouts.mock.calls.some(([, delay], index) => {
      const result = timeouts.mock.results[index];
      return delay === 4_000 && result?.type === "return" && !cleared.has(result.value);
    });
  };
  return {
    spool,
    flushAfterClaims: async (ids: string[], imageParts: number, queuedMessages: number) => {
      await vi.waitFor(
        async () => {
          expect((await queue.listClaims()).map((claim) => claim.id).toSorted()).toEqual(
            ids.toSorted(),
          );
          expect(admit).toHaveBeenCalledTimes(imageParts);
          expect(enterLane).toHaveBeenCalledTimes(queuedMessages);
          expect(hasPendingFlush()).toBe(true);
        },
        // Vitest advances fake time by the polling interval; readiness must not age the set.
        { interval: 0, timeout: 20_000 },
      );
      await vi.advanceTimersByTimeAsync(4_000);
    },
    stop: async () => {
      let settled = false;
      const stopping = Promise.allSettled([spool.stop()]);
      void stopping.then(() => {
        settled = true;
      });
      try {
        await vi.waitFor(
          async () => {
            // Failed assertions can leave another partial set queued behind the released gate.
            await vi.advanceTimersByTimeAsync(hasPendingFlush() ? 4_000 : 0);
            expect(settled).toBe(true);
          },
          { interval: 0, timeout: 20_000 },
        );
        const [result] = await stopping;
        if (result.status === "rejected") {
          throw result.reason;
        }
      } finally {
        admit.mockRestore();
        enterLane.mockRestore();
        clearedTimeouts.mockRestore();
        timeouts.mockRestore();
        vi.useRealTimers();
      }
    },
  };
}
function acceptEvent(
  spool: ReturnType<typeof createLineWebhookSpool>,
  event: Parameters<typeof createEvent>[0],
) {
  return spool.accept(callback(createEvent(event)));
}
function orderedDelivery(
  labelFor: (message: webhook.MessageEvent["message"]) => string,
  blocked: string,
) {
  const order: string[] = [];
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  let active = 0;
  let overlapped = false;
  const deliver = vi.fn<Deliver>(async (events, _destination, control) => {
    active += 1;
    overlapped ||= active > 1;
    const label = labelFor((events[0] as webhook.MessageEvent).message);
    if (label === blocked) {
      entered.resolve();
      await release.promise;
    }
    order.push(label);
    active -= 1;
    await control.turnAdoptionLifecycle.onAdopted();
  });
  return {
    deliver,
    order,
    entered,
    release,
    get overlapped() {
      return overlapped;
    },
  };
}
describe("LINE webhook spool image sets", () => {
  it("hands back every claim in a set when shutdown interrupts its delivery", async () => {
    await withQueue(async (queue) => {
      const delivering = createDeferred<void>();
      // Resolves without adopting: the turn never reaches an agent, so every
      // claim behind it has to go back to the queue rather than stay deferred.
      const deliver = vi.fn(async () => {
        await delivering.promise;
      });
      const spool = createSpool(queue, deliver);
      spool.start();
      try {
        for (const index of [1, 2]) {
          await acceptEvent(spool, {
            webhookEventId: `event-stop-set-${index}`,
            userId: "user-stop-set",
            imageSet: { id: "set-stop", index, total: 2 },
          });
        }
        await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1), { timeout: 20_000 });
        const stopping = spool.stop();
        delivering.resolve();
        await stopping;
        // Both parts, not just the one the drain was holding.
        expect(await queue.listPending()).toHaveLength(2);
      } finally {
        delivering.resolve();
      }
    });
  });
  it("still aggregates a set when a text lands between its parts", async () => {
    await withQueue(async (queue) => {
      const turns: string[] = [];
      const deliver = vi.fn<Deliver>(async (events, _destination, control) => {
        const kinds = events.map((event) => (event as webhook.MessageEvent).message.type);
        if (kinds[0] === "image") {
          expect(events.map((event) => (event as webhook.MessageEvent).message.id)).toEqual([
            "message-event-split-1",
            "message-event-split-2",
            "message-event-split-3",
          ]);
        }
        turns.push(`${kinds[0]}x${events.length}`);
        await control.turnAdoptionLifecycle.onAdopted();
      });
      const spool = createSpool(queue, deliver);
      const imagePart = (index: number) =>
        acceptEvent(spool, {
          webhookEventId: `event-split-${index}`,
          userId: "user-split",
          imageSet: { id: "set-split", index, total: 3 },
        });
      spool.start();
      try {
        await imagePart(2);
        await acceptEvent(spool, { webhookEventId: "event-split-text", userId: "user-split" });
        await imagePart(1);
        await imagePart(3);
        await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2), { timeout: 20_000 });
        // One image turn carrying all three parts, then the text behind it.
        expect(turns).toEqual(["imagex3", "textx1"]);
      } finally {
        await spool.stop();
      }
    });
  });
  it("returns every buffered claim when the combined delivery rejects", async () => {
    await withQueue(async (queue) => {
      const deliver = vi.fn(async () => {
        throw new Error("combined turn failed before adoption");
      });
      const spool = createSpool(queue, deliver);
      spool.start();
      try {
        for (const index of [1, 2]) {
          await acceptEvent(spool, {
            webhookEventId: `event-reject-${index}`,
            userId: "user-reject",
            imageSet: { id: "set-reject", index, total: 2 },
          });
        }
        await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
        // Both parts come back for retry; neither is stranded in a held claim.
        await vi.waitFor(
          async () => {
            const pending = await queue.listPending();
            expect(pending).toHaveLength(2);
          },
          { timeout: 20_000 },
        );
      } finally {
        await spool.stop();
      }
    });
  });
  it("keeps a later message on the same lane behind an incomplete image set", async () => {
    await withQueue(async (queue) => {
      const runtimeEnv = runtime();
      // Keep the lane while media preparation is paused, not merely while buffering parts.
      const delivery = orderedDelivery((message) => message.type, "image");
      const { deliver, order, entered, release } = delivery;
      const clock = createImageSetClockSpool(queue, deliver, runtimeEnv);
      const { spool } = clock;
      spool.start();
      try {
        // An image set that never completes: only its timer can release the lane.
        await acceptEvent(spool, {
          webhookEventId: "event-incomplete",
          userId: "user-order",
          imageSet: { id: "set-order", index: 1, total: 3 },
        });
        await acceptEvent(spool, { webhookEventId: "event-after", userId: "user-order" });
        await clock.flushAfterClaims(
          ["message:message-event-incomplete", "message:message-event-after"],
          1,
          1,
        );
        await entered.promise;
        expect(runtimeEnv.error).toHaveBeenCalledWith(
          expect.stringContaining(
            "image set set-order delivered 1 of the send's parts, 2 still missing",
          ),
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(deliver).toHaveBeenCalledTimes(1);
        expect(order).toEqual([]);
        release.resolve();
        await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2), {
          interval: 0,
          timeout: 20_000,
        });
        expect(order).toEqual(["image", "text"]);
      } finally {
        release.resolve();
        await clock.stop();
      }
    });
  });
  it("delivers two messages queued behind an image set in arrival order", async () => {
    await withQueue(async (queue) => {
      // A slow first queued message must not be overtaken by the second.
      const delivery = orderedDelivery(
        (message) => (message.type === "text" ? message.text : message.type),
        "first",
      );
      const { deliver, order, entered, release } = delivery;
      const clock = createImageSetClockSpool(queue, deliver);
      const { spool } = clock;
      spool.start();
      try {
        await acceptEvent(spool, {
          webhookEventId: "event-set-queue",
          userId: "user-queue",
          imageSet: { id: "set-queue", index: 1, total: 3 },
        });
        await acceptEvent(spool, {
          webhookEventId: "event-first",
          userId: "user-queue",
          text: "first",
        });
        await acceptEvent(spool, {
          webhookEventId: "event-second",
          userId: "user-queue",
          text: "second",
        });
        await clock.flushAfterClaims(
          [
            "message:message-event-set-queue",
            "message:message-event-first",
            "message:message-event-second",
          ],
          1,
          2,
        );
        await entered.promise;
        await vi.advanceTimersByTimeAsync(0);
        expect(deliver).toHaveBeenCalledTimes(2);
        expect(order).toEqual(["image"]);
        expect(delivery.overlapped).toBe(false);
        release.resolve();
        await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(3), {
          interval: 0,
          timeout: 20_000,
        });
        expect(order).toEqual(["image", "first", "second"]);
        expect(delivery.overlapped).toBe(false);
      } finally {
        release.resolve();
        await clock.stop();
      }
    });
  });
  it("keeps a later image set behind a message already queued on the lane", async () => {
    await withQueue(async (queue) => {
      // A complete later set must wait while the queued text builds its turn.
      const delivery = orderedDelivery(
        (message) => (message.type === "text" ? message.text : message.id.slice(-4)),
        "queued",
      );
      const { deliver, order, entered, release } = delivery;
      const clock = createImageSetClockSpool(queue, deliver);
      const { spool } = clock;
      spool.start();
      try {
        await acceptEvent(spool, {
          webhookEventId: "event-set-a",
          messageId: "message-seta",
          userId: "user-mixed",
          imageSet: { id: "set-a", index: 1, total: 3 },
        });
        await acceptEvent(spool, {
          webhookEventId: "event-mid",
          userId: "user-mixed",
          text: "queued",
        });
        for (const index of [1, 2]) {
          await acceptEvent(spool, {
            webhookEventId: `event-set-b-${index}`,
            messageId: `message-setb${index}`,
            userId: "user-mixed",
            imageSet: { id: "set-b", index, total: 2 },
          });
        }
        await clock.flushAfterClaims(
          [
            "message:message-seta",
            "message:message-event-mid",
            "message:message-setb1",
            "message:message-setb2",
          ],
          3,
          1,
        );
        await entered.promise;
        await vi.advanceTimersByTimeAsync(0);
        expect(deliver).toHaveBeenCalledTimes(2);
        expect(order).toEqual(["seta"]);
        expect(delivery.overlapped).toBe(false);
        release.resolve();
        await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(3), {
          interval: 0,
          timeout: 30_000,
        });
        expect(order).toEqual(["seta", "queued", "etb1"]);
        expect(delivery.overlapped).toBe(false);
      } finally {
        release.resolve();
        await clock.stop();
      }
    });
  });
  it("returns the parts a rejected mid-set adoption never reached", async () => {
    await withQueue(async (queue) => {
      const reclaimed = "message:message-event-lost-2";
      const lossyQueue: typeof queue = {
        ...queue,
        complete: async (idOrClaim, options) => {
          const id = typeof idOrClaim === "string" ? idOrClaim : idOrClaim.id;
          // false means another owner holds the claim; the drain turns that into
          // IngressAdoptionLostError, rejecting this constituent's adoption.
          return id === reclaimed ? false : await queue.complete(idOrClaim, options);
        },
      };
      const deliver = vi.fn<Deliver>(async (_events, _destination, control) => {
        await control.turnAdoptionLifecycle.onAdopted();
      });
      const spool = createSpool(lossyQueue, deliver);
      spool.start();
      try {
        for (const index of [1, 2, 3]) {
          await acceptEvent(spool, {
            webhookEventId: `event-lost-${index}`,
            userId: "user-lost",
            imageSet: { id: "set-lost", index, total: 3 },
          });
        }
        await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1), { timeout: 20_000 });
        // The third part sat behind the lost one and was never adopted; it comes
        // back for retry instead of staying held until recovery.
        const stranded = "message:message-event-lost-3";
        await vi.waitFor(
          async () => {
            expect((await queue.listPending()).map((record) => record.id)).toContain(stranded);
          },
          { timeout: 20_000 },
        );
        expect((await queue.listClaims()).map((claim) => claim.id)).not.toContain(stranded);
      } finally {
        await spool.stop();
      }
    });
  });
});
