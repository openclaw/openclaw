// Slack tests cover durable Events API admission, replay, and tombstones.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { App, Receiver, ReceiverEvent } from "@slack/bolt";
import type { ChannelIngressQueue } from "openclaw/plugin-sdk/channel-outbound";
import type { PluginJsonValue } from "openclaw/plugin-sdk/plugin-entry";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "openclaw/plugin-sdk/system-event-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerSlackMemberEvents } from "./events/members.js";
import { createSlackSystemEventTestHarness } from "./events/system-event-test-harness.js";
import { createSlackDurableIngress, resolveSlackIngressTurnLifecycle } from "./ingress.js";

type SlackIngressQueue = NonNullable<Parameters<typeof createSlackDurableIngress>[0]["queue"]>;
type SlackIngressPayload = Parameters<SlackIngressQueue["enqueue"]>[1];

function createSlackEnvelope(
  eventId: string,
  ts = "1700000000.000100",
  event?: Record<string, PluginJsonValue>,
) {
  return {
    team_id: "T_TEST",
    api_app_id: "A_TEST",
    type: "event_callback",
    event_id: eventId,
    event_time: 1_700_000_000,
    event: event ?? {
      type: "message",
      channel: "C_TEST",
      user: "U_TEST",
      ts,
      client_msg_id: "client-message-1",
      text: "hello",
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
  options: { retryNum?: number; ts?: string; event?: Record<string, PluginJsonValue> } = {},
): ReceiverEvent {
  return {
    body: createSlackEnvelope(eventId, options.ts, options.event),
    ack,
    ...(options.retryNum === undefined ? {} : { retryNum: options.retryNum }),
  };
}

function attachIngress(
  queue: ChannelIngressQueue<SlackIngressPayload>,
  processEvent: (event: ReceiverEvent) => Promise<void>,
  options?: { pollIntervalMs?: number },
) {
  const ingress = createSlackDurableIngress({
    accountId: "default",
    queue,
    pollIntervalMs: options?.pollIntervalMs ?? 60_000,
    adoptionStallTimeoutMs: 5_000,
  });
  const harness = createReceiverHarness();
  ingress.wrapReceiver(harness.receiver).init({ processEvent } as App);
  return { ingress, receive: harness.receive };
}

function createMemberEvent(
  type: "member_joined_channel" | "member_left_channel",
  eventTs: string,
  channelType: "channel" | "im" = "channel",
) {
  return {
    type,
    user: "U_TEST",
    channel: "C_TEST",
    channel_type: channelType,
    event_ts: eventTs,
  };
}

function createMemberEventDispatch(params?: {
  dmPolicy?: "open" | "disabled";
  channelType?: "channel" | "im";
  failUserLookupOnce?: boolean;
}) {
  const harness = createSlackSystemEventTestHarness({
    channelType: params?.channelType ?? "channel",
    ...(params?.dmPolicy ? { dmPolicy: params.dmPolicy } : {}),
  });
  if (params?.failUserLookupOnce === true) {
    let userLookupCount = 0;
    harness.ctx.resolveUserName = async () => {
      userLookupCount += 1;
      // Authorization deliberately treats profile lookup as optional. Fail the
      // second, display-name lookup so the handler itself must retry.
      if (userLookupCount === 2) {
        throw new Error("users.info temporarily unavailable");
      }
      return { name: "alice" };
    };
  }
  registerSlackMemberEvents({ ctx: harness.ctx });
  const dispatch = vi.fn(async (receiverEvent: ReceiverEvent) => {
    const body = receiverEvent.body as ReturnType<typeof createSlackEnvelope>;
    const event = body.event as Record<string, unknown>;
    const handler = harness.getHandler(String(event.type));
    if (!handler) {
      throw new Error(`missing test handler for ${String(event.type)}`);
    }
    const durableHandler = handler as (args: {
      event: Record<string, unknown>;
      body: unknown;
      context: Record<string, unknown>;
    }) => Promise<void>;
    await durableHandler({
      event,
      body,
      context: receiverEvent.customProperties ?? {},
    });
  });
  return { dispatch, ctx: harness.ctx };
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
    resetSystemEventsForTest();
  });

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

  it("preserves join-leave-join occurrences while ingress owns retry dedupe", async () => {
    await withQueue(async (queue) => {
      const { dispatch } = createMemberEventDispatch();
      const { ingress, receive } = attachIngress(queue, dispatch);
      ingress.start();

      for (const [eventId, event] of [
        ["Ev-member-join-1", createMemberEvent("member_joined_channel", "100.001")],
        ["Ev-member-left", createMemberEvent("member_left_channel", "100.002")],
        ["Ev-member-join-2", createMemberEvent("member_joined_channel", "100.003")],
      ] as const) {
        await receive(createReceiverEvent(eventId, undefined, { event }));
        await ingress.waitForIdle();
      }
      await receive(
        createReceiverEvent("Ev-member-join-2", undefined, {
          retryNum: 1,
          event: createMemberEvent("member_joined_channel", "100.003"),
        }),
      );
      await ingress.waitForIdle();

      expect(dispatch).toHaveBeenCalledTimes(3);
      expect(peekSystemEventEntries("agent:main:main").map((entry) => entry.contextKey)).toEqual([
        "slack:member:joined:c_test:u_test:ev-member-join-1",
        "slack:member:left:c_test:u_test:ev-member-left",
        "slack:member:joined:c_test:u_test:ev-member-join-2",
      ]);
      await ingress.stop();
    });
  });

  it("retries transient member handler failures instead of tombstoning them", async () => {
    await withQueue(async (queue) => {
      const { dispatch, ctx } = createMemberEventDispatch({ failUserLookupOnce: true });
      const runtimeError = vi.fn();
      ctx.runtime.error = runtimeError;
      const first = attachIngress(queue, dispatch);
      first.ingress.start();
      await first.receive(
        createReceiverEvent("Ev-member-retry", undefined, {
          event: createMemberEvent("member_joined_channel", "200.001"),
        }),
      );
      await first.ingress.waitForIdle();
      await first.ingress.stop();

      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(runtimeError).not.toHaveBeenCalled();
      expect(peekSystemEventEntries("agent:main:main")).toHaveLength(0);

      const restarted = attachIngress(queue, dispatch, { pollIntervalMs: 25 });
      restarted.ingress.start();
      await vi.waitFor(
        async () => {
          await restarted.ingress.waitForIdle();
          expect(dispatch).toHaveBeenCalledTimes(2);
        },
        { timeout: 15_000, interval: 100 },
      );

      expect(peekSystemEventEntries("agent:main:main")).toHaveLength(1);
      await restarted.ingress.stop();
    });
  });

  it("terminally completes durable member events rejected by channel policy", async () => {
    await withQueue(async (queue) => {
      const { dispatch } = createMemberEventDispatch({
        dmPolicy: "disabled",
        channelType: "im",
      });
      const first = attachIngress(queue, dispatch);
      first.ingress.start();
      await first.receive(
        createReceiverEvent("Ev-member-policy-drop", undefined, {
          event: createMemberEvent("member_joined_channel", "300.001", "im"),
        }),
      );
      await first.ingress.waitForIdle();
      await first.ingress.stop();

      const restarted = attachIngress(queue, dispatch);
      restarted.ingress.start();
      await restarted.ingress.waitForIdle();

      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(peekSystemEventEntries("agent:main:main")).toHaveLength(0);
      expect((await queue.enqueue("Ev-member-policy-drop", {} as SlackIngressPayload)).kind).toBe(
        "completed",
      );
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
