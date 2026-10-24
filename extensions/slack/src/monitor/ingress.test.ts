import type { ReceiverEvent } from "@slack/bolt";
import type { WebClientOptions } from "@slack/web-api";
import { closeOpenClawStateDatabaseForTest } from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import type {
  ChannelIngressMonitorLifecycle,
  ChannelIngressQueue,
} from "openclaw/plugin-sdk/channel-outbound";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { PluginJsonValue } from "openclaw/plugin-sdk/plugin-entry";
import { peekSystemEventEntries } from "openclaw/plugin-sdk/system-event-runtime";
import { resetSystemEventsForTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installSlackTestRuntime } from "../test-runtime.test-support.js";
import { registerSlackMemberEvents } from "./events/members.js";
import { createSlackDurableIngress, resolveSlackIngressTurnLifecycle } from "./ingress.js";
import { attachBoltIngress, withQueue } from "./ingress.test-support.js";
import { claimSlackMessageDispatchReplay } from "./message-dispatch-dedupe.js";
import { createMonitorTestContext } from "./monitor-context.test-support.js";

type SlackIngressQueue = NonNullable<Parameters<typeof createSlackDurableIngress>[0]["queue"]>;
type SlackIngressPayload = Parameters<SlackIngressQueue["enqueue"]>[1];
type ReplayGuard = Parameters<typeof claimSlackMessageDispatchReplay>[0]["guard"];

const memberEvents = () => peekSystemEventEntries("agent:main:slack:channel:c_test");

const channelMessage = (fields: Record<string, PluginJsonValue>) => ({
  type: "message",
  channel: "C_TEST",
  channel_type: "channel",
  user: "U_TEST",
  ...fields,
});

function createReceiverEvent(
  eventId: string,
  ack = vi.fn(async () => {}),
  options: {
    retryNum?: number;
    ts?: string;
    event?: Record<string, PluginJsonValue>;
  } = {},
): ReceiverEvent {
  return {
    body: {
      team_id: "T_TEST",
      api_app_id: "A_TEST",
      type: "event_callback",
      event_id: eventId,
      event_time: 1_700_000_000,
      event:
        options.event ??
        channelMessage({
          ts: options.ts ?? "1700000000.000100",
          client_msg_id: "client-message-1",
          text: "hello",
        }),
    },
    ack,
    ...(options.retryNum === undefined ? {} : { retryNum: options.retryNum }),
  };
}

function createMemberEvent(type: "member_joined_channel" | "member_left_channel", eventTs: string) {
  return {
    type,
    user: "U_TEST",
    channel: "C_TEST",
    channel_type: "channel",
    event_ts: eventTs,
  };
}

function attachBoltMemberIngress(params: {
  queue: ChannelIngressQueue<SlackIngressPayload>;
  usersInfoFetch?: NonNullable<WebClientOptions["fetch"]>;
  pollIntervalMs?: number;
}) {
  installSlackTestRuntime();
  const { app, ingress, receive } = attachBoltIngress(params.queue, {
    pollIntervalMs: params.pollIntervalMs ?? 60_000,
    adoptionStallTimeoutMs: 5_000,
    ...(params.usersInfoFetch
      ? {
          clientOptions: {
            fetch: params.usersInfoFetch,
            retryConfig: { retries: 0 },
            slackApiUrl: "https://slack.test/api/",
          },
        }
      : {}),
  });
  vi.spyOn(app.client.conversations, "info").mockResolvedValue({
    ok: true,
    channel: { id: "C_TEST", name: "general", is_channel: true },
  });
  if (!params.usersInfoFetch) {
    vi.spyOn(app.client.users, "info").mockResolvedValue({
      ok: true,
      user: { id: "U_TEST", name: "alice" },
    });
  }
  const ctx = createMonitorTestContext({
    cfg: {},
    app,
    teamId: "T_TEST",
    apiAppId: "A_TEST",
    installationIdentity: { kind: "workspace", teamId: "T_TEST" },
    allowNameMatching: true,
    channelsConfig: { C_TEST: { users: ["alice"], enabled: true } },
    groupPolicy: "open",
    useAccessGroups: false,
  });
  // This Bolt retry fixture starts after policy resolution, with the explicit policy above.
  ctx.readRuntimeContext = async () => ctx;
  registerSlackMemberEvents({ ctx });
  return { ingress, receive };
}

function attachIngress(
  queue: ChannelIngressQueue<SlackIngressPayload>,
  processEvent: (event: ReceiverEvent) => Promise<void>,
  options: { adoptionStallTimeoutMs?: number; pollIntervalMs?: number } = {},
) {
  const { app, ingress, receive } = attachBoltIngress(queue, {
    pollIntervalMs: options.pollIntervalMs ?? 60_000,
    adoptionStallTimeoutMs: options.adoptionStallTimeoutMs ?? 5_000,
  });
  vi.spyOn(app, "processEvent").mockImplementation(processEvent);
  return { ingress, receive };
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
      const ackStarted = createDeferred<void>();
      const ackGate = createDeferred<void>();
      const order: string[] = [];
      const processEvent = vi.fn(async (event: ReceiverEvent) => {
        order.push("dispatch");
        await resolveSlackIngressTurnLifecycle(event.customProperties)?.onAdopted();
      });
      const { ingress, receive } = attachIngress(queue, processEvent);
      const ack = vi.fn(async () => {
        order.push("ack-start");
        ackStarted.resolve();
        await ackGate.promise;
        order.push("ack-complete");
      });
      ingress.start();

      const receiving = receive(createReceiverEvent("Ev-ack-order", ack));
      try {
        await Promise.race([ackStarted.promise, receiving]);
        expect(processEvent).not.toHaveBeenCalled();

        ackGate.resolve();
        await receiving;
        await ingress.waitForIdle();

        expect(order).toEqual(["ack-start", "ack-complete", "dispatch"]);
      } finally {
        ackGate.resolve();
        try {
          await receiving;
        } finally {
          await ingress.stop();
        }
      }
    });
  });

  it("releases a waiting duplicate's channel lane while preserving its migration fence", async () => {
    await withQueue(async (queue) => {
      const duplicate = createDeferred<boolean>();
      const starts: string[] = [];
      const processEvent = vi.fn(async (receiverEvent: ReceiverEvent) => {
        const id = (receiverEvent.body as { event_id: string }).event_id;
        const lifecycle = resolveSlackIngressTurnLifecycle(receiverEvent.customProperties)!;
        if (id === "Ev-duplicate") {
          await claimSlackMessageDispatchReplay({
            guard: {
              claim: async () => ({ kind: "inflight", pending: duplicate.promise }),
            } as unknown as ReplayGuard,
            key: "logical-message",
            onWaiting: () => lifecycle.onDispatchWaiting?.(),
          });
          starts.push(id);
          return;
        }
        starts.push(id);
        await lifecycle.onAdopted();
      });
      const { ingress, receive } = attachIngress(queue, processEvent, {
        adoptionStallTimeoutMs: 80,
      });
      ingress.start();
      try {
        await receive(createReceiverEvent("Ev-duplicate"));
        await vi.waitFor(() => expect(processEvent).toHaveBeenCalledOnce());
        await receive(
          createReceiverEvent("Ev-independent", undefined, { ts: "1700000001.000100" }),
        );
        await vi.waitFor(() => expect(starts).toEqual(["Ev-independent"]), { timeout: 500 });
        await receive(
          createReceiverEvent("Ev-migration", undefined, {
            event: {
              type: "channel_id_changed",
              old_channel_id: "C_OLD",
              new_channel_id: "C_TEST",
            },
          }),
        );
        // The original claim can outlive the pre-adoption watchdog without
        // restarting the duplicate or letting a channel migration overtake it.
        await new Promise((resolve) => {
          setTimeout(resolve, 160);
        });
        expect(starts).toEqual(["Ev-independent"]);
        expect(processEvent).toHaveBeenCalledTimes(2);
        duplicate.resolve(true);
        await ingress.waitForIdle();
        expect(starts).toEqual(["Ev-independent", "Ev-duplicate", "Ev-migration"]);
        expect([await queue.listPending(), await queue.listClaims()]).toEqual([[], []]);
      } finally {
        duplicate.resolve(true);
        await ingress.stop();
      }
    });
  });

  it("readmits a released twin before reclaiming dispatch and rearms its watchdog", async () => {
    await withQueue(async (queue) => {
      const owner = createDeferred<boolean>();
      const handle = { commit: vi.fn(async () => true), release: vi.fn() };
      const claim = vi
        .fn()
        .mockResolvedValueOnce({ kind: "inflight", pending: owner.promise })
        .mockResolvedValue({ kind: "claimed", handle });
      let attempts = 0;
      let retrySignal: AbortSignal | undefined;
      const starts: string[] = [];
      const processEvent = vi.fn(async (event: ReceiverEvent) => {
        const id = (event.body as { event_id: string }).event_id;
        const lifecycle = resolveSlackIngressTurnLifecycle(event.customProperties)!;
        if (id !== "Ev-released-twin") {
          starts.push(id);
          await lifecycle.onAdopted();
          return;
        }
        attempts += 1;
        await claimSlackMessageDispatchReplay({
          guard: { claim } as unknown as ReplayGuard,
          key: "logical-message",
          onWaiting: () => lifecycle.onDispatchWaiting?.(),
        });
        retrySignal = lifecycle.abortSignal;
        // A newly admitted owner must still be covered while routing stalls.
        await new Promise<void>((resolve) => {
          lifecycle.abortSignal.addEventListener("abort", () => resolve(), { once: true });
        });
        handle.release();
        lifecycle.abortSignal.throwIfAborted();
      });
      const { ingress, receive } = attachIngress(queue, processEvent, {
        adoptionStallTimeoutMs: 160,
        pollIntervalMs: 10,
      });
      ingress.start();
      try {
        await receive(createReceiverEvent("Ev-released-twin"));
        await vi.waitFor(() => expect(claim).toHaveBeenCalledOnce());
        owner.reject(new Error("original dispatch failed"));
        await vi.waitFor(() => expect(attempts).toBe(2), { timeout: 2_000 });
        await receive(createReceiverEvent("Ev-later", undefined, { ts: "1700000002.000100" }));
        expect(starts).toEqual([]);
        await vi.waitFor(() => expect(retrySignal?.aborted).toBe(true));
        await vi.waitFor(async () => {
          expect(await queue.listPending()).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ id: "Ev-released-twin", attempts: 2 }),
            ]),
          );
        });
      } finally {
        await ingress.stop();
      }
    });
  });

  it.each([
    ["independent threads", true],
    ["threads sharing a session", false],
  ] as const)("orders %s by the routed session", async (_name, independent) => {
    await withQueue(async (queue) => {
      const gate = createDeferred<void>();
      const starts: string[] = [];
      const timestamps = ["1700000000.000101", "1700000000.000201"];
      const processEvent = vi.fn(async (received: ReceiverEvent) => {
        const event = received.body.event as { ts: string; thread_ts?: string };
        const lifecycle = resolveSlackIngressTurnLifecycle(received.customProperties);
        await lifecycle?.onSessionRouted?.(
          independent ? `thread:${event.thread_ts}` : "shared-session",
        );
        starts.push(event.ts);
        if (event.ts === timestamps[0]) {
          await gate.promise;
        }
        await lifecycle?.onAdopted();
      });
      const { ingress, receive } = attachIngress(queue, processEvent);
      ingress.start();
      try {
        for (const [index, ts] of timestamps.entries()) {
          await receive(
            createReceiverEvent(`Ev-session-${index}`, undefined, {
              event: channelMessage({
                ts,
                text: "hello",
                thread_ts: ts.slice(0, -1) + "0",
              }),
            }),
          );
        }
        await vi.waitFor(
          () =>
            expect([processEvent.mock.calls.length, starts]).toEqual([
              2,
              independent ? timestamps : [timestamps[0]],
            ]),
          { timeout: 500 },
        );
        gate.resolve();
        await ingress.waitForIdle();
        expect(starts).toEqual(timestamps);
      } finally {
        gate.resolve();
        await ingress.waitForIdle();
        await ingress.stop();
      }
    });
  });

  it("keeps a queued same-session event alive past the adoption watchdog", async () => {
    await withQueue(async (queue) => {
      const firstSettlement = createDeferred<void>();
      const starts: string[] = [];
      const ids = ["Ev-first", "Ev-second", "Ev-third"];
      const processEvent = vi.fn(async (receiverEvent: ReceiverEvent) => {
        const eventId = (receiverEvent.body as { event_id: string }).event_id;
        const lifecycle = resolveSlackIngressTurnLifecycle(receiverEvent.customProperties);
        await lifecycle?.onSessionRouted?.("agent:main:slack:shared-session");
        starts.push(eventId);
        if (eventId === ids[0]) {
          (lifecycle as ChannelIngressMonitorLifecycle).onAdoptionFinalizing();
          await firstSettlement.promise;
        }
        await lifecycle?.onAdopted();
      });
      const { ingress, receive } = attachIngress(queue, processEvent, {
        adoptionStallTimeoutMs: 80,
      });
      ingress.start();

      try {
        await receive(createReceiverEvent(ids[0]!));
        await receive(createReceiverEvent(ids[1]!));
        await vi.waitFor(() => expect(processEvent).toHaveBeenCalledTimes(2));
        expect(starts).toEqual(ids.slice(0, 1));

        await new Promise<void>((resolve) => {
          setTimeout(resolve, 120);
        });
        await receive(createReceiverEvent(ids[2]!));
        await vi.waitFor(() => expect(processEvent).toHaveBeenCalledTimes(3));
        expect([(await queue.listClaims()).map((claim) => claim.id), starts]).toEqual([
          ids,
          ids.slice(0, 1),
        ]);

        firstSettlement.resolve();
        await ingress.waitForIdle();
        expect(starts).toEqual(ids);
        expect(await queue.listPending()).toEqual([]);
      } finally {
        firstSettlement.resolve();
        await ingress.waitForIdle();
        await ingress.stop();
      }
    });
  });

  it.each([
    ["migration before a message", true, false],
    ["migration after a routed message", false, false],
    ["migration after a deferred message", false, true],
  ] as const)("fences %s through Bolt", async (_name, migrationFirst, deferred) => {
    await withQueue(async (queue) => {
      const started = createDeferred<void>();
      const gate = createDeferred<void>();
      const starts: string[] = [];
      const { app, ingress, receive } = attachBoltIngress(queue, {
        adoptionStallTimeoutMs: 5_000,
      });
      const firstType = migrationFirst ? "channel_id_changed" : "message";
      const waitFirst = async (type: string) => {
        starts.push(type);
        if (type === firstType) {
          started.resolve();
          await gate.promise;
        }
      };
      app.event("message", async ({ context }) => {
        const lifecycle = resolveSlackIngressTurnLifecycle(context);
        await lifecycle?.onSessionRouted?.("agent:main:slack:thread:C_NEW");
        if (deferred) {
          lifecycle?.onDeferred();
        }
        await waitFirst("message");
        await lifecycle?.onAdopted();
      });
      app.event("channel_id_changed", async ({ context }) => {
        await waitFirst("channel_id_changed");
        await resolveSlackIngressTurnLifecycle(context)?.onAdopted();
      });
      const migration = createReceiverEvent("Ev-migration", undefined, {
        event: { type: "channel_id_changed", old_channel_id: "C_OLD", new_channel_id: "C_NEW" },
      });
      const message = createReceiverEvent("Ev-message", undefined, {
        event: channelMessage({
          channel: "C_NEW",
          ts: "1700000000.000200",
          thread_ts: "1700000000.000100",
          text: "hello",
        }),
      });
      ingress.start();
      try {
        await receive(migrationFirst ? migration : message);
        await started.promise;
        await receive(migrationFirst ? message : migration);
        if (!migrationFirst) {
          await vi.waitFor(async () =>
            expect((await queue.listClaims()).map((claim) => claim.id)).toEqual([
              "Ev-message",
              "Ev-migration",
            ]),
          );
        }
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(starts).toEqual([firstType]);
        gate.resolve();
        await ingress.waitForIdle();
        expect(starts).toEqual(
          migrationFirst ? ["channel_id_changed", "message"] : ["message", "channel_id_changed"],
        );
      } finally {
        gate.resolve();
        await ingress.waitForIdle();
        await ingress.stop();
      }
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

  it.each([
    { name: "a lane derived only at drain time", laneKey: undefined },
    { name: "its persisted channel-only lane", laneKey: "team:T_TEST:conversation:C_TEST" },
  ])("recovers a shipped threaded row with $name", async ({ laneKey }) => {
    await withQueue(async (queue) => {
      const body = createReceiverEvent("Ev-legacy-lane", undefined, {
        event: {
          type: "message",
          channel: "C_TEST",
          channel_type: "channel",
          user: "U_TEST",
          ts: "1700000000.000101",
          thread_ts: "1700000000.000100",
          text: "persisted thread reply",
        },
      }).body;
      await queue.enqueue(
        "Ev-legacy-lane",
        {
          version: 1,
          receivedAt: 1_700_000_000_000,
          kind: "events-api",
          body,
        },
        { receivedAt: 1_700_000_000_000, ...(laneKey ? { laneKey } : {}) },
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

  it("preserves repeated member occurrences through Bolt while deduping Slack retries", async () => {
    await withQueue(async (queue) => {
      const { ingress, receive } = attachBoltMemberIngress({ queue });
      ingress.start();
      try {
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

        expect(memberEvents().map((entry) => entry.contextKey)).toEqual([
          "slack:member:joined:c_test:u_test:ev-member-join-1",
          "slack:member:left:c_test:u_test:ev-member-left",
          "slack:member:joined:c_test:u_test:ev-member-join-2",
        ]);
      } finally {
        await ingress.stop();
      }
    });
  });

  it("retries transient member failures through Bolt after restart", async () => {
    await withQueue(async (queue) => {
      let usersInfoRequests = 0;
      const usersInfoFetch = vi.fn<NonNullable<WebClientOptions["fetch"]>>(async (input) => {
        const pathname = new URL(String(input)).pathname;
        if (!pathname.endsWith("/users.info")) {
          throw new Error(`unexpected Slack API request: ${pathname}`);
        }
        usersInfoRequests += 1;
        if (usersInfoRequests === 1) {
          return new Response(JSON.stringify({ ok: false, error: "ratelimited" }), {
            headers: { "content-type": "application/json", "retry-after": "0" },
            status: 429,
          });
        }
        return Response.json({ ok: true, user: { id: "U_TEST", name: "alice" } });
      });
      const first = attachBoltMemberIngress({ queue, usersInfoFetch });
      first.ingress.start();
      let restarted: ReturnType<typeof attachBoltMemberIngress> | undefined;
      try {
        await first.receive(
          createReceiverEvent("Ev-member-retry", undefined, {
            event: createMemberEvent("member_joined_channel", "200.001"),
          }),
        );
        await first.ingress.waitForIdle();
        await first.ingress.stop();

        expect(memberEvents()).toHaveLength(0);
        expect((await queue.listPending()).map((entry) => entry.id)).toContain("Ev-member-retry");

        restarted = attachBoltMemberIngress({
          queue,
          usersInfoFetch,
          pollIntervalMs: 25,
        });
        restarted.ingress.start();
        await vi.waitFor(
          async () => {
            await restarted?.ingress.waitForIdle();
            expect(memberEvents()).toHaveLength(1);
          },
          { timeout: 15_000, interval: 100 },
        );

        expect(usersInfoRequests).toBe(2);
      } finally {
        await first.ingress.stop();
        await restarted?.ingress.stop();
      }
    });
  });
});
