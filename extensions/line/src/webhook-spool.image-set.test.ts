// Line tests cover grouping the durable claims LINE splits one multi-image send into.
import type { webhook } from "@line/bot-sdk";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import * as imageSetIngress from "./inbound-image-set.js";
import { createLineWebhookSpool, type LineWebhookTurnAdoptionLifecycle } from "./webhook-spool.js";
import { callback, createEvent, runtime, withQueue } from "./webhook-spool.test-support.js";

type SpoolOptions = Parameters<typeof createLineWebhookSpool>[0];

function createImageSetClockSpool(
  options: SpoolOptions & { queue: NonNullable<SpoolOptions["queue"]> },
) {
  const factory = vi.spyOn(imageSetIngress, "createLineImageSetIngressBuffer");
  let spool: ReturnType<typeof createLineWebhookSpool>;
  let buffer: ReturnType<typeof imageSetIngress.createLineImageSetIngressBuffer>;
  try {
    spool = createLineWebhookSpool(options);
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
          expect((await options.queue.listClaims()).map((claim) => claim.id).toSorted()).toEqual(
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

describe("LINE webhook spool image sets", () => {
  // LINE splits one multi-image send across several webhook events on one lane.
  // The spool groups their claims so the set reaches the handler as a single turn.
  it("delivers a same-lane image set as one turn owning every part's claim", async () => {
    await withQueue(async (queue) => {
      const delivered: (readonly webhook.Event[])[] = [];
      const deliver = vi.fn(
        async (
          events: readonly webhook.Event[],
          _destination: string,
          control: { turnAdoptionLifecycle: LineWebhookTurnAdoptionLifecycle },
        ) => {
          delivered.push(events);
          await control.turnAdoptionLifecycle.onAdopted();
        },
      );
      const spool = createLineWebhookSpool({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver,
      });

      spool.start();
      try {
        for (const index of [2, 1, 3]) {
          await spool.accept(
            callback(
              createEvent({
                webhookEventId: `event-image-set-${index}`,
                userId: "user-image-set",
                imageSet: { id: "set-1", index, total: 3 },
              }),
            ),
          );
        }

        // One delivery carrying the whole set, ordered the way the sender picked.
        await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
        expect(delivered[0]?.map((event) => (event as webhook.MessageEvent).message.id)).toEqual([
          "message-event-image-set-1",
          "message-event-image-set-2",
          "message-event-image-set-3",
        ]);

        // Adopting that one turn settles all three durable claims.
        await vi.waitFor(async () => expect(await queue.listPending()).toHaveLength(0));
      } finally {
        await spool.stop();
      }
    });
  });

  // A part that arrives while the spool is stopping must not be parked in a buffer
  // that will never flush; it goes back so a restart redelivers the whole set.
  it("hands an image-set part back instead of buffering it while stopping", async () => {
    await withQueue(async (queue) => {
      const deliver = vi.fn(async () => {});
      const spool = createLineWebhookSpool({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver,
      });

      spool.start();
      await spool.stop();
      await spool.accept(
        callback(
          createEvent({
            webhookEventId: "event-stopping-set",
            userId: "user-stopping",
            imageSet: { id: "set-stopping", index: 1, total: 3 },
          }),
        ),
      );

      // Still queued for a later process rather than consumed by a dead buffer.
      expect(await queue.listPending()).toHaveLength(1);
      expect(deliver).not.toHaveBeenCalled();
    });
  });

  // Shutdown mid-delivery must return every claim the combined turn consumed, not
  // only the holder's, or the deferred parts stay held until recovery.
  it("hands back every claim in a set when shutdown interrupts its delivery", async () => {
    await withQueue(async (queue) => {
      let releaseDelivery = () => {};
      const delivering = new Promise<void>((resolve) => {
        releaseDelivery = resolve;
      });
      // Resolves without adopting: the turn never reaches an agent, so every
      // claim behind it has to go back to the queue rather than stay deferred.
      const deliver = vi.fn(async () => {
        await delivering;
      });
      const spool = createLineWebhookSpool({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver,
      });

      spool.start();
      try {
        for (const index of [1, 2]) {
          await spool.accept(
            callback(
              createEvent({
                webhookEventId: `event-stop-set-${index}`,
                userId: "user-stop-set",
                imageSet: { id: "set-stop", index, total: 2 },
              }),
            ),
          );
        }
        await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1), { timeout: 20_000 });

        const stopping = spool.stop();
        releaseDelivery();
        await stopping;

        // Both parts, not just the one the drain was holding.
        expect(await queue.listPending()).toHaveLength(2);
      } finally {
        releaseDelivery();
      }
    });
  });

  // A text landing between image parts must not become the lane owner: the parts
  // that follow could then never be claimed, and the set would split into a
  // partial image turn, the text, and a second image turn.
  it("still aggregates a set when a text lands between its parts", async () => {
    await withQueue(async (queue) => {
      const turns: string[] = [];
      const deliver = vi.fn(
        async (
          events: readonly webhook.Event[],
          _destination: string,
          control: { turnAdoptionLifecycle: LineWebhookTurnAdoptionLifecycle },
        ) => {
          const kinds = events.map((event) => (event as webhook.MessageEvent).message.type);
          turns.push(`${kinds[0]}x${events.length}`);
          await control.turnAdoptionLifecycle.onAdopted();
        },
      );
      const spool = createLineWebhookSpool({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver,
      });
      const imagePart = (index: number) =>
        callback(
          createEvent({
            webhookEventId: `event-split-${index}`,
            userId: "user-split",
            imageSet: { id: "set-split", index, total: 3 },
          }),
        );

      spool.start();
      try {
        await spool.accept(imagePart(1));
        await spool.accept(
          callback(createEvent({ webhookEventId: "event-split-text", userId: "user-split" })),
        );
        await spool.accept(imagePart(2));
        await spool.accept(imagePart(3));

        await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2), { timeout: 20_000 });
        // One image turn carrying all three parts, then the text behind it.
        expect(turns).toEqual(["imagex3", "textx1"]);
      } finally {
        await spool.stop();
      }
    });
  });

  // A combined delivery that rejects before the handoff rides back to the holder's
  // drain only. Every other part already returned as deferred, so the failure has
  // to reach their claims too or they stay held until recovery.
  it("returns every buffered claim when the combined delivery rejects", async () => {
    await withQueue(async (queue) => {
      const deliver = vi.fn(async () => {
        throw new Error("combined turn failed before adoption");
      });
      const spool = createLineWebhookSpool({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver,
      });

      spool.start();
      try {
        for (const index of [1, 2]) {
          await spool.accept(
            callback(
              createEvent({
                webhookEventId: `event-reject-${index}`,
                userId: "user-reject",
                imageSet: { id: "set-reject", index, total: 2 },
              }),
            ),
          );
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

  // The lane is released so the rest of a set can be claimed; a message the sender
  // sent afterwards must still arrive after the images, not before them.
  it("keeps a later message on the same lane behind an incomplete image set", async () => {
    await withQueue(async (queue) => {
      const order: string[] = [];
      const imageEntered = createDeferred<void>();
      const releaseImage = createDeferred<void>();
      const deliver = vi.fn(
        async (
          events: readonly webhook.Event[],
          _destination: string,
          control: { turnAdoptionLifecycle: LineWebhookTurnAdoptionLifecycle },
        ) => {
          const kind = (events[0] as webhook.MessageEvent).message.type;
          if (kind === "image") {
            // The real handler fetches every part's media before its turn exists.
            // The lane has to stay held across that work, not just until the set
            // is taken, or the later message wins the race to the agent.
            imageEntered.resolve();
            await releaseImage.promise;
          }
          order.push(kind);
          await control.turnAdoptionLifecycle.onAdopted();
        },
      );
      const clock = createImageSetClockSpool({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver,
      });
      const { spool } = clock;

      spool.start();
      try {
        // An image set that never completes: only its timer can release the lane.
        await spool.accept(
          callback(
            createEvent({
              webhookEventId: "event-incomplete",
              userId: "user-order",
              imageSet: { id: "set-order", index: 1, total: 3 },
            }),
          ),
        );
        await spool.accept(
          callback(createEvent({ webhookEventId: "event-after", userId: "user-order" })),
        );

        await clock.flushAfterClaims(
          ["message:message-event-incomplete", "message:message-event-after"],
          1,
          1,
        );
        await imageEntered.promise;
        await vi.advanceTimersByTimeAsync(0);
        expect(deliver).toHaveBeenCalledTimes(1);
        expect(order).toEqual([]);
        releaseImage.resolve();
        await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2), {
          interval: 0,
          timeout: 20_000,
        });
        expect(order).toEqual(["image", "text"]);
      } finally {
        releaseImage.resolve();
        await clock.stop();
      }
    });
  });

  it("delivers two messages queued behind an image set in arrival order", async () => {
    await withQueue(async (queue) => {
      const order: string[] = [];
      let inFlight = 0;
      let overlapped = false;
      const firstEntered = createDeferred<void>();
      const releaseFirst = createDeferred<void>();
      const deliver = vi.fn(
        async (
          events: readonly webhook.Event[],
          _destination: string,
          control: { turnAdoptionLifecycle: LineWebhookTurnAdoptionLifecycle },
        ) => {
          inFlight += 1;
          overlapped ||= inFlight > 1;
          const message = (events[0] as webhook.MessageEvent).message;
          const label = message.type === "text" ? message.text : message.type;
          // The first queued message prepares slowly. Released together, the
          // second would reach the agent first and reorder the conversation.
          if (label === "first") {
            firstEntered.resolve();
            await releaseFirst.promise;
          }
          order.push(label);
          inFlight -= 1;
          await control.turnAdoptionLifecycle.onAdopted();
        },
      );
      const clock = createImageSetClockSpool({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver,
      });
      const { spool } = clock;

      spool.start();
      try {
        await spool.accept(
          callback(
            createEvent({
              webhookEventId: "event-set-queue",
              userId: "user-queue",
              imageSet: { id: "set-queue", index: 1, total: 3 },
            }),
          ),
        );
        await spool.accept(
          callback(
            createEvent({ webhookEventId: "event-first", userId: "user-queue", text: "first" }),
          ),
        );
        await spool.accept(
          callback(
            createEvent({ webhookEventId: "event-second", userId: "user-queue", text: "second" }),
          ),
        );

        await clock.flushAfterClaims(
          [
            "message:message-event-set-queue",
            "message:message-event-first",
            "message:message-event-second",
          ],
          1,
          2,
        );
        await firstEntered.promise;
        await vi.advanceTimersByTimeAsync(0);
        expect(deliver).toHaveBeenCalledTimes(2);
        expect(order).toEqual(["image"]);
        expect(overlapped).toBe(false);
        releaseFirst.resolve();
        await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(3), {
          interval: 0,
          timeout: 20_000,
        });
        expect(order).toEqual(["image", "first", "second"]);
        expect(overlapped).toBe(false);
      } finally {
        releaseFirst.resolve();
        await clock.stop();
      }
    });
  });

  it("keeps a later image set behind a message already queued on the lane", async () => {
    await withQueue(async (queue) => {
      const order: string[] = [];
      let inFlight = 0;
      let overlapped = false;
      const messageEntered = createDeferred<void>();
      const releaseMessage = createDeferred<void>();
      const deliver = vi.fn(
        async (
          events: readonly webhook.Event[],
          _destination: string,
          control: { turnAdoptionLifecycle: LineWebhookTurnAdoptionLifecycle },
        ) => {
          inFlight += 1;
          overlapped ||= inFlight > 1;
          const message = (events[0] as webhook.MessageEvent).message;
          const label =
            message.type === "text" ? message.text : (message as { id: string }).id.slice(-4);
          if (message.type === "text") {
            // A queued message still has to build its turn. The later set is
            // already whole, so nothing but the lane queue can stop it from
            // overtaking this work the moment the first set lets go.
            messageEntered.resolve();
            await releaseMessage.promise;
          }
          order.push(label);
          inFlight -= 1;
          await control.turnAdoptionLifecycle.onAdopted();
        },
      );
      const clock = createImageSetClockSpool({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver,
      });
      const { spool } = clock;

      spool.start();
      try {
        await spool.accept(
          callback(
            createEvent({
              webhookEventId: "event-set-a",
              messageId: "message-seta",
              userId: "user-mixed",
              imageSet: { id: "set-a", index: 1, total: 3 },
            }),
          ),
        );
        await spool.accept(
          callback(
            createEvent({ webhookEventId: "event-mid", userId: "user-mixed", text: "queued" }),
          ),
        );
        for (const index of [1, 2]) {
          await spool.accept(
            callback(
              createEvent({
                webhookEventId: `event-set-b-${index}`,
                messageId: `message-setb${index}`,
                userId: "user-mixed",
                imageSet: { id: "set-b", index, total: 2 },
              }),
            ),
          );
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
        await messageEntered.promise;
        await vi.advanceTimersByTimeAsync(0);
        expect(deliver).toHaveBeenCalledTimes(2);
        expect(order).toEqual(["seta"]);
        expect(overlapped).toBe(false);
        releaseMessage.resolve();
        await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(3), {
          interval: 0,
          timeout: 30_000,
        });
        expect(order).toEqual(["seta", "queued", "etb1"]);
        expect(overlapped).toBe(false);
      } finally {
        releaseMessage.resolve();
        await clock.stop();
      }
    });
  });
  // A set that never completes is delivered short. The turn answers what arrived,
  // so the shortfall is only knowable here - the operator sees a small media count
  // and nothing else that explains it.
  it("reports how many parts a short set was missing", async () => {
    await withQueue(async (queue) => {
      const errors: string[] = [];
      const runtimeEnv = {
        ...runtime(),
        error: (...args: unknown[]) => {
          errors.push(String(args[0]));
        },
      };
      const deliver = vi.fn(
        async (
          _events: readonly webhook.Event[],
          _destination: string,
          control: { turnAdoptionLifecycle: LineWebhookTurnAdoptionLifecycle },
        ) => {
          await control.turnAdoptionLifecycle.onAdopted();
        },
      );
      const clock = createImageSetClockSpool({
        accountId: "default",
        runtime: runtimeEnv,
        queue,
        deliver,
      });
      const { spool } = clock;

      spool.start();
      try {
        // Two of a three-part set arrive; the third never does.
        for (const index of [1, 2]) {
          await spool.accept(
            callback(
              createEvent({
                webhookEventId: `event-short-${index}`,
                userId: "user-short",
                imageSet: { id: "set-short", index, total: 3 },
              }),
            ),
          );
        }

        await clock.flushAfterClaims(
          ["message:message-event-short-1", "message:message-event-short-2"],
          2,
          0,
        );
        await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1), {
          interval: 0,
          timeout: 20_000,
        });
        expect(deliver.mock.calls[0]?.[0]).toHaveLength(2);
        expect(errors.join("\n")).toContain(
          "image set set-short delivered 2 of the send's parts, 1 still missing",
        );
      } finally {
        await clock.stop();
      }
    });
  });

  // A later part's adoption write can lose its claim to another owner. The
  // handoff is already marked by then, so the parts the adoption loop never
  // reached have to be released here or they stay claimed until recovery.
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
      const deliver = vi.fn(
        async (
          _events: readonly webhook.Event[],
          _destination: string,
          control: { turnAdoptionLifecycle: LineWebhookTurnAdoptionLifecycle },
        ) => {
          await control.turnAdoptionLifecycle.onAdopted();
        },
      );
      const spool = createLineWebhookSpool({
        accountId: "default",
        runtime: runtime(),
        queue: lossyQueue,
        deliver,
      });

      spool.start();
      try {
        for (const index of [1, 2, 3]) {
          await spool.accept(
            callback(
              createEvent({
                webhookEventId: `event-lost-${index}`,
                userId: "user-lost",
                imageSet: { id: "set-lost", index, total: 3 },
              }),
            ),
          );
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
