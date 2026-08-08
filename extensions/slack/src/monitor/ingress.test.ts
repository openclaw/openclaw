// Slack tests cover durable Events API admission, replay, and tombstones.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { App, Receiver, ReceiverEvent } from "@slack/bolt";
import type { ChannelIngressQueue } from "openclaw/plugin-sdk/channel-outbound";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSlackDurableIngress, resolveSlackIngressTurnLifecycle } from "./ingress.js";

type SlackIngressQueue = NonNullable<Parameters<typeof createSlackDurableIngress>[0]["queue"]>;
type SlackIngressPayload = Parameters<SlackIngressQueue["enqueue"]>[1];

function createSlackEnvelope(
  eventId: string,
  ts = "1700000000.000100",
  eventOverrides: Record<string, unknown> = {},
) {
  return {
    team_id: "T_TEST",
    api_app_id: "A_TEST",
    type: "event_callback",
    event_id: eventId,
    event_time: 1_700_000_000,
    event: {
      type: "message",
      channel: "C_TEST",
      user: "U_TEST",
      ts,
      client_msg_id: "client-message-1",
      text: "hello",
      ...eventOverrides,
    },
  };
}

function createChannelIdChangedEnvelope(
  eventId: string,
  oldChannelId: string,
  newChannelId: string,
) {
  return {
    team_id: "T_TEST",
    api_app_id: "A_TEST",
    type: "event_callback",
    event_id: eventId,
    event_time: 1_700_000_000,
    event: {
      type: "channel_id_changed",
      old_channel_id: oldChannelId,
      new_channel_id: newChannelId,
    },
  };
}

function createReceiverHarness() {
  let receive: ((event: ReceiverEvent) => Promise<void>) | undefined;
  const receiver: Receiver = {
    init: (app) => {
      receive = async (event) => await app.processEvent(event);
    },
    start: async () => undefined,
    stop: async () => undefined,
  };
  return {
    receiver,
    receive: async (event: ReceiverEvent) => {
      if (!receive) {
        throw new Error("Receiver not initialized");
      }
      await receive(event);
    },
  };
}

function createReceiverEvent(
  eventId: string,
  ack = vi.fn(async () => {}),
  options: { retryNum?: number; ts?: string; eventOverrides?: Record<string, unknown> } = {},
): ReceiverEvent {
  return {
    body: createSlackEnvelope(eventId, options.ts, options.eventOverrides),
    ack,
    ...(options.retryNum === undefined ? {} : { retryNum: options.retryNum }),
  };
}

function createReceiverEventWithBody(body: Record<string, unknown>): ReceiverEvent {
  return { body, ack: vi.fn(async () => {}) };
}

function attachIngress(
  queue: ChannelIngressQueue<SlackIngressPayload>,
  processEvent: (event: ReceiverEvent) => Promise<void>,
) {
  const ingress = createSlackDurableIngress({
    accountId: "default",
    queue,
    pollIntervalMs: 60_000,
    adoptionStallTimeoutMs: 5_000,
  });
  const harness = createReceiverHarness();
  ingress.wrapReceiver(harness.receiver).init({ processEvent } as App);
  return { ingress, receive: harness.receive };
}

async function withQueue(
  fn: (queue: ChannelIngressQueue<SlackIngressPayload>) => Promise<void>,
): Promise<void> {
  const rawRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), `openclaw-slack-ingress-${crypto.randomUUID()}-`),
  );
  const stateDir = await fs.realpath(rawRoot);
  const queue = createChannelIngressQueueForTests<SlackIngressPayload>({
    channelId: "slack",
    accountId: "default",
    stateDir,
  });
  try {
    await fn(queue);
  } finally {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

describe("Slack durable ingress", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  it.each([
    {
      name: "top-level room messages",
      eventOverrides: (threadTs: string) => ({ ts: threadTs }),
    },
    {
      name: "threaded messages",
      eventOverrides: (threadTs: string) => ({ thread_ts: threadTs }),
    },
    {
      name: "nested message changes",
      eventOverrides: (threadTs: string) => ({
        subtype: "message_changed",
        message: { thread_ts: threadTs },
      }),
    },
    {
      name: "assistant thread events",
      eventOverrides: (threadTs: string) => ({
        type: "assistant_thread_started",
        assistant_thread: { channel_id: "C_TEST", thread_ts: threadTs },
      }),
    },
  ])(
    "dispatches independent $name in the same channel concurrently",
    async ({ eventOverrides }) => {
      await withQueue(async (queue) => {
        let releaseFirst = () => {};
        const firstDelivery = new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        const dispatched: string[] = [];
        const { ingress, receive } = attachIngress(queue, async (event) => {
          const body = event.body as { event_id: string };
          dispatched.push(body.event_id);
          if (body.event_id === "Ev-thread-first") {
            await firstDelivery;
          }
          await resolveSlackIngressTurnLifecycle(event.customProperties)?.onAdopted();
        });
        ingress.start();

        try {
          await receive(
            createReceiverEvent("Ev-thread-first", undefined, {
              eventOverrides: eventOverrides("1700000000.000001"),
            }),
          );
          await vi.waitFor(() => expect(dispatched).toEqual(["Ev-thread-first"]));

          await receive(
            createReceiverEvent("Ev-thread-second", undefined, {
              eventOverrides: eventOverrides("1700000000.000002"),
            }),
          );
          await vi.waitFor(() =>
            expect(dispatched).toEqual(["Ev-thread-first", "Ev-thread-second"]),
          );
        } finally {
          releaseFirst();
          await ingress.waitForIdle();
          await ingress.stop();
        }
      });
    },
  );

  it.each([
    {
      name: "the same Slack thread",
      firstEventOverrides: { thread_ts: "1700000000.000001" },
      secondEventOverrides: { thread_ts: "1700000000.000001" },
    },
    {
      name: "a Slack thread root and its first reply",
      firstEventOverrides: {},
      secondEventOverrides: { thread_ts: "1700000000.000100" },
    },
    {
      name: "a top-level Slack direct message",
      firstEventOverrides: { channel: "D_TEST", channel_type: "im" },
      secondEventOverrides: { channel: "D_TEST", channel_type: "im" },
    },
    {
      name: "a Slack direct-message root and its first reply",
      firstEventOverrides: { channel: "D_TEST", channel_type: "im" },
      secondEventOverrides: {
        channel: "D_TEST",
        channel_type: "im",
        thread_ts: "1700000000.000100",
      },
    },
    {
      name: "a Slack room root and its deletion",
      firstEventOverrides: {},
      secondEventOverrides: {
        subtype: "message_deleted",
        ts: "1700000000.000900",
        deleted_ts: "1700000000.000100",
      },
    },
    {
      name: "a Slack room reply and its deletion",
      firstEventOverrides: { thread_ts: "1700000000.000001" },
      secondEventOverrides: {
        subtype: "message_deleted",
        ts: "1700000000.000900",
        deleted_ts: "1700000000.000200",
        previous_message: {
          ts: "1700000000.000200",
          thread_ts: "1700000000.000001",
        },
      },
    },
    {
      name: "non-message channel events",
      firstEventOverrides: { type: "reaction_added" },
      secondEventOverrides: { type: "reaction_removed" },
    },
  ])(
    "preserves durable delivery ordering within $name",
    async ({ firstEventOverrides, secondEventOverrides }) => {
      await withQueue(async (queue) => {
        let releaseFirst = () => {};
        const firstDelivery = new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        const dispatched: string[] = [];
        const { ingress, receive } = attachIngress(queue, async (event) => {
          const body = event.body as { event_id: string };
          dispatched.push(body.event_id);
          if (body.event_id === "Ev-ordered-first") {
            await firstDelivery;
          }
          await resolveSlackIngressTurnLifecycle(event.customProperties)?.onAdopted();
        });
        ingress.start();

        try {
          await receive(
            createReceiverEvent("Ev-ordered-first", undefined, {
              eventOverrides: firstEventOverrides,
            }),
          );
          await vi.waitFor(() => expect(dispatched).toEqual(["Ev-ordered-first"]));

          await receive(
            createReceiverEvent("Ev-ordered-second", undefined, {
              eventOverrides: secondEventOverrides,
            }),
          );
          await vi.waitFor(async () => {
            expect((await queue.listPending()).map((record) => record.id)).toContain(
              "Ev-ordered-second",
            );
          });
          expect(dispatched).toEqual(["Ev-ordered-first"]);

          releaseFirst();
          await ingress.waitForIdle();
          expect(dispatched).toEqual(["Ev-ordered-first", "Ev-ordered-second"]);
        } finally {
          releaseFirst();
          await ingress.waitForIdle();
          await ingress.stop();
        }
      });
    },
  );

  it("does not acknowledge when the durable append fails", async () => {
    await withQueue(async (queue) => {
      const enqueue = vi.fn(async () => {
        throw new Error("database unavailable");
      });
      const failingQueue = { ...queue, enqueue } as ChannelIngressQueue<SlackIngressPayload>;
      const processEvent = vi.fn(async () => {});
      const { ingress, receive } = attachIngress(failingQueue, processEvent);
      const ack = vi.fn(async () => {});

      await expect(receive(createReceiverEvent("Ev-append-failure", ack))).rejects.toThrow(
        "database unavailable",
      );

      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(ack).not.toHaveBeenCalled();
      expect(processEvent).not.toHaveBeenCalled();
      await ingress.stop();
    });
  });

  it("acknowledges a durable event before dispatch starts", async () => {
    await withQueue(async (queue) => {
      let releaseAck = () => {};
      const ackGate = new Promise<void>((resolve) => {
        releaseAck = resolve;
      });
      const order: string[] = [];
      const processEvent = vi.fn(async (event: ReceiverEvent) => {
        order.push("dispatch");
        await resolveSlackIngressTurnLifecycle(event.customProperties)?.onAdopted();
      });
      const { ingress, receive } = attachIngress(queue, processEvent);
      const ack = vi.fn(async () => {
        order.push("ack-start");
        await ackGate;
        order.push("ack-complete");
      });
      ingress.start();

      const receiving = receive(createReceiverEvent("Ev-ack-order", ack));
      await vi.waitFor(() => expect(ack).toHaveBeenCalledTimes(1));
      expect(processEvent).not.toHaveBeenCalled();

      releaseAck();
      await receiving;
      await ingress.waitForIdle();

      expect(order).toEqual(["ack-start", "ack-complete", "dispatch"]);
      await ingress.stop();
    });
  });

  it("serializes new-channel messages behind channel-ID migration", async () => {
    await withQueue(async (queue) => {
      let markMigrationStarted: () => void = () => {};
      let releaseMigration: () => void = () => {};
      const migrationStarted = new Promise<void>((resolve) => {
        markMigrationStarted = resolve;
      });
      const migrationGate = new Promise<void>((resolve) => {
        releaseMigration = resolve;
      });
      const starts: string[] = [];
      const processEvent = vi.fn(async (receiverEvent: ReceiverEvent) => {
        const event = (receiverEvent.body as { event?: { type?: string } }).event;
        const type = event?.type ?? "unknown";
        starts.push(type);
        if (type === "channel_id_changed") {
          markMigrationStarted();
          await migrationGate;
        }
        await resolveSlackIngressTurnLifecycle(receiverEvent.customProperties)?.onAdopted();
      });
      const { ingress, receive } = attachIngress(queue, processEvent);
      ingress.start();

      await receive(
        createReceiverEventWithBody(
          createChannelIdChangedEnvelope("Ev-channel-migrate", "C_OLD", "C_NEW"),
        ),
      );
      await receive(
        createReceiverEventWithBody({
          ...createSlackEnvelope("Ev-new-channel-message"),
          event: {
            type: "message",
            channel: "C_NEW",
            user: "U_TEST",
            ts: "1700000000.000200",
            text: "after migration",
          },
        }),
      );

      await migrationStarted;
      await Promise.resolve();
      expect(starts).toEqual(["channel_id_changed"]);

      releaseMigration();
      await ingress.waitForIdle();
      expect(starts).toEqual(["channel_id_changed", "message"]);
      await ingress.stop();
    });
  });

  it("drains a durable event when its acknowledgement fails", async () => {
    await withQueue(async (queue) => {
      const processEvent = vi.fn(async (event: ReceiverEvent) => {
        await resolveSlackIngressTurnLifecycle(event.customProperties)?.onAdopted();
      });
      const { ingress, receive } = attachIngress(queue, processEvent);
      const ackError = new Error("connection closed");
      ingress.start();

      await expect(
        receive(createReceiverEvent("Ev-ack-failure", vi.fn().mockRejectedValue(ackError))),
      ).rejects.toBe(ackError);
      await ingress.waitForIdle();

      expect(processEvent).toHaveBeenCalledTimes(1);
      await ingress.stop();
    });
  });

  it("recovers an uncompleted event with a fresh drain and dispatches once", async () => {
    await withQueue(async (queue) => {
      const first = attachIngress(
        queue,
        vi.fn(async () => {}),
      );
      const ack = vi.fn(async () => {});
      await first.receive(createReceiverEvent("Ev-restart", ack));
      await first.ingress.stop();

      const dispatch = vi.fn(async (event: ReceiverEvent) => {
        await resolveSlackIngressTurnLifecycle(event.customProperties)?.onAdopted();
      });
      const restarted = attachIngress(queue, dispatch);
      restarted.ingress.start();
      await restarted.ingress.waitForIdle();

      expect(ack).toHaveBeenCalledTimes(1);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect((await queue.enqueue("Ev-restart", {} as SlackIngressPayload)).kind).toBe("completed");
      await restarted.ingress.stop();
    });
  });

  it("recovers a shipped row whose lane was derived only at drain time", async () => {
    await withQueue(async (queue) => {
      const body = createSlackEnvelope("Ev-legacy-lane");
      await queue.enqueue(
        "Ev-legacy-lane",
        {
          version: 1,
          receivedAt: 1_700_000_000_000,
          kind: "events-api",
          body,
        },
        { receivedAt: 1_700_000_000_000 },
      );
      const dispatch = vi.fn(async (event: ReceiverEvent) => {
        await resolveSlackIngressTurnLifecycle(event.customProperties)?.onAdopted();
      });
      const recovered = attachIngress(queue, dispatch);
      recovered.ingress.start();
      await recovered.ingress.waitForIdle();

      expect(dispatch).toHaveBeenCalledTimes(1);
      expect((await queue.enqueue("Ev-legacy-lane", {} as SlackIngressPayload)).kind).toBe(
        "completed",
      );
      await recovered.ingress.stop();
    });
  });

  it("retains completion so the same event_id cannot dispatch twice", async () => {
    await withQueue(async (queue) => {
      const dispatch = vi.fn(async (event: ReceiverEvent) => {
        await resolveSlackIngressTurnLifecycle(event.customProperties)?.onAdopted();
      });
      const { ingress, receive } = attachIngress(queue, dispatch);
      ingress.start();
      await receive(createReceiverEvent("Ev-completed"));
      await ingress.waitForIdle();

      const duplicateAck = vi.fn(async () => {});
      await receive(createReceiverEvent("Ev-completed", duplicateAck, { retryNum: 1 }));
      await ingress.waitForIdle();

      expect(duplicateAck).toHaveBeenCalledTimes(1);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect((await queue.enqueue("Ev-completed", {} as SlackIngressPayload)).kind).toBe(
        "completed",
      );
      await ingress.stop();
    });
  });

  it("dedupes Slack's delayed message redelivery after restart via the tombstone", async () => {
    await withQueue(async (queue) => {
      const firstDispatch = vi.fn(async (event: ReceiverEvent) => {
        await resolveSlackIngressTurnLifecycle(event.customProperties)?.onAdopted();
      });
      const first = attachIngress(queue, firstDispatch);
      first.ingress.start();
      await first.receive(
        createReceiverEvent("Ev-delayed-redelivery", undefined, {
          ts: "1700000000.000350",
        }),
      );
      await first.ingress.waitForIdle();
      await first.ingress.stop();

      const replayDispatch = vi.fn(async () => {});
      const restarted = attachIngress(queue, replayDispatch);
      const retryAck = vi.fn(async () => {});
      await restarted.receive(
        createReceiverEvent("Ev-delayed-redelivery", retryAck, {
          retryNum: 3,
          ts: "1700000000.000350",
        }),
      );
      restarted.ingress.start();
      await restarted.ingress.waitForIdle();

      expect(firstDispatch).toHaveBeenCalledTimes(1);
      expect(retryAck).toHaveBeenCalledTimes(1);
      expect(replayDispatch).not.toHaveBeenCalled();
      await restarted.ingress.stop();
    });
  });
});

describe("Slack relay durable ingress", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  const relayMessage = {
    type: "message",
    channel: "C_RELAY",
    team: "T_TEST",
    user: "U_TEST",
    ts: "1700000001.000200",
    text: "relayed",
  };

  it("dedupes a router redelivery by logical message identity, not delivery id", async () => {
    await withQueue(async (queue) => {
      const dispatched: unknown[] = [];
      const ingress = createSlackDurableIngress({
        accountId: "default",
        queue,
        pollIntervalMs: 60_000,
        adoptionStallTimeoutMs: 5_000,
      });
      ingress.attachRelayDispatch(async (message) => {
        dispatched.push(message);
      });
      ingress.start();

      await ingress.acceptRelayEvent({ deliveryId: "delivery-1", message: relayMessage });
      await ingress.waitForIdle();
      // Redelivery after a lost ack carries a fresh delivery id but the same message.
      await ingress.acceptRelayEvent({ deliveryId: "delivery-2", message: relayMessage });
      await ingress.waitForIdle();

      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]).toMatchObject({ channel: "C_RELAY", text: "relayed" });
      await ingress.stop();
    });
  });

  it("retries a claimed relay event until a dispatcher attaches", async () => {
    await withQueue(async (queue) => {
      const detached = createSlackDurableIngress({
        accountId: "default",
        queue,
        pollIntervalMs: 60_000,
        adoptionStallTimeoutMs: 5_000,
      });
      // Accept durably, then stop before any dispatcher exists (crash window).
      await detached.acceptRelayEvent({ deliveryId: "delivery-3", message: relayMessage });
      await detached.stop();

      const dispatched: unknown[] = [];
      const recovered = createSlackDurableIngress({
        accountId: "default",
        queue,
        pollIntervalMs: 25,
        adoptionStallTimeoutMs: 5_000,
      });
      recovered.start();
      await recovered.waitForIdle();
      expect(dispatched).toHaveLength(0);

      recovered.attachRelayDispatch(async (message) => {
        dispatched.push(message);
      });
      // First retry obeys the drain's backoff; give it room without flake.
      await vi.waitFor(
        async () => {
          await recovered.waitForIdle();
          expect(dispatched).toHaveLength(1);
        },
        { timeout: 15_000, interval: 250 },
      );
      await recovered.stop();
    });
  });
});
