// Slack tests cover durable Events API admission, replay, and tombstones.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { App, type Receiver, type ReceiverEvent } from "@slack/bolt";
import type { WebClientOptions } from "@slack/web-api";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import type {
  ChannelIngressMonitorLifecycle,
  ChannelIngressQueue,
} from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { PluginJsonValue } from "openclaw/plugin-sdk/plugin-entry";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { peekSystemEventEntries } from "openclaw/plugin-sdk/system-event-runtime";
import { resetSystemEventsForTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installSlackTestRuntime } from "../test-runtime.test-support.js";
import { createSlackMonitorContext } from "./context.js";
import { registerSlackMemberEvents } from "./events/members.js";
import { createSlackDurableIngress, resolveSlackIngressTurnLifecycle } from "./ingress.js";
import {
  attachBoltIngress,
  createReceiverEvent as createBoltReceiverEvent,
  withQueue as withBoltQueue,
} from "./ingress.test-support.js";
import { claimSlackMessageDispatchReplay } from "./message-dispatch-dedupe.js";

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
  options: {
    retryNum?: number;
    ts?: string;
    event?: Record<string, PluginJsonValue>;
  } = {},
): ReceiverEvent {
  return {
    body: createSlackEnvelope(eventId, options.ts, options.event),
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
  trackEvent: () => void;
  usersInfo?: App["client"]["users"]["info"];
  usersInfoFetch?: NonNullable<WebClientOptions["fetch"]>;
  pollIntervalMs?: number;
}) {
  installSlackTestRuntime();
  const ingress = createSlackDurableIngress({
    accountId: "default",
    queue: params.queue,
    pollIntervalMs: params.pollIntervalMs ?? 60_000,
    adoptionStallTimeoutMs: 5_000,
  });
  const receiverHarness = createReceiverHarness();
  const app = new App({
    receiver: ingress.wrapReceiver(receiverHarness.receiver),
    authorize: async () => ({
      botToken: "xoxb-test",
      botId: "B_BOT",
      botUserId: "U_BOT",
      teamId: "T_TEST",
    }),
    ...(params.usersInfoFetch
      ? {
          clientOptions: {
            fetch: params.usersInfoFetch,
            retryConfig: { retries: 0 },
            slackApiUrl: "https://slack.test/api/",
          },
        }
      : {}),
    convoStore: false,
    ignoreSelf: false,
  });
  vi.spyOn(app.client.conversations, "info").mockResolvedValue({
    ok: true,
    channel: { id: "C_TEST", name: "general", is_channel: true },
  });
  if (!params.usersInfoFetch) {
    vi.spyOn(app.client.users, "info").mockImplementation(
      params.usersInfo ??
        (async () => ({
          ok: true,
          user: { id: "U_TEST", name: "alice" },
        })),
    );
  }
  const ctx = createSlackMonitorContext({
    cfg: {} as OpenClawConfig,
    accountId: "default",
    botToken: "xoxb-test",
    app,
    runtime: {} as RuntimeEnv,
    botUserId: "U_BOT",
    botId: "B_BOT",
    identityHealth: { lifecycle: "ready", lastError: null },
    teamId: "T_TEST",
    apiAppId: "A_TEST",
    installationIdentity: { kind: "workspace", teamId: "T_TEST" },
    historyLimit: 0,
    sessionScope: "per-sender",
    mainKey: "main",
    dmEnabled: true,
    dmPolicy: "open",
    allowFrom: [],
    allowNameMatching: true,
    groupDmEnabled: true,
    groupDmChannels: [],
    defaultRequireMention: true,
    channelsConfig: { C_TEST: { users: ["alice"], enabled: true } },
    groupPolicy: "open",
    useAccessGroups: false,
    reactionMode: "off",
    reactionAllowlist: [],
    replyToMode: "off",
    slashCommand: {
      enabled: false,
      name: "openclaw",
      sessionPrefix: "slack:slash",
      ephemeral: true,
    },
    textLimit: 4000,
    typingReaction: "",
    mediaMaxBytes: 1,
    threadHistoryScope: "thread",
    threadInheritParent: false,
  });
  // This Bolt retry fixture starts after policy resolution, with the explicit policy above.
  ctx.readRuntimeContext = async () => ctx;
  registerSlackMemberEvents({ ctx, trackEvent: params.trackEvent });
  return { ingress, receive: receiverHarness.receive };
}

function createReceiverEventWithBody(body: Record<string, unknown>): ReceiverEvent {
  return { body, ack: vi.fn(async () => {}) };
}

function attachIngress(
  queue: ChannelIngressQueue<SlackIngressPayload>,
  processEvent: (event: ReceiverEvent) => Promise<void>,
  options: { adoptionStallTimeoutMs?: number; pollIntervalMs?: number } = {},
) {
  const ingress = createSlackDurableIngress({
    accountId: "default",
    queue,
    pollIntervalMs: options.pollIntervalMs ?? 60_000,
    adoptionStallTimeoutMs: options.adoptionStallTimeoutMs ?? 5_000,
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
    resetSystemEventsForTest();
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
        expect(ack).toHaveBeenCalledTimes(1);
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
            } as unknown as Parameters<typeof claimSlackMessageDispatchReplay>[0]["guard"],
            key: "logical-message",
            onWaiting: lifecycle.onDispatchWaiting,
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
          createReceiverEventWithBody(
            createChannelIdChangedEnvelope("Ev-migration", "C_OLD", "C_TEST"),
          ),
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
        expect(await queue.listPending()).toEqual([]);
        expect(await queue.listClaims()).toEqual([]);
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
          guard: { claim } as unknown as Parameters<
            typeof claimSlackMessageDispatchReplay
          >[0]["guard"],
          key: "logical-message",
          onWaiting: lifecycle.onDispatchWaiting,
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
        expect(claim).toHaveBeenCalledTimes(2);
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

  it("dispatches independently routed threads concurrently after session ownership is established", async () => {
    await withQueue(async (queue) => {
      let releaseFirstDispatch: () => void = () => {};
      const firstDispatchGate = new Promise<void>((resolve) => {
        releaseFirstDispatch = resolve;
      });
      const starts: string[] = [];
      const processEvent = vi.fn(async (receiverEvent: ReceiverEvent) => {
        const event = (receiverEvent.body as { event: { thread_ts: string } }).event;
        const lifecycle = resolveSlackIngressTurnLifecycle(receiverEvent.customProperties);
        await lifecycle?.onSessionRouted?.(`agent:main:slack:thread:${event.thread_ts}`);
        starts.push(event.thread_ts);
        if (event.thread_ts === "1700000000.000100") {
          await firstDispatchGate;
        }
        await lifecycle?.onAdopted();
      });
      const { ingress, receive } = attachIngress(queue, processEvent);
      ingress.start();

      try {
        for (const [eventId, threadTs, ts] of [
          ["Ev-thread-one", "1700000000.000100", "1700000000.000101"],
          ["Ev-thread-two", "1700000000.000200", "1700000000.000201"],
        ] as const) {
          await receive(
            createReceiverEvent(eventId, undefined, {
              event: {
                type: "message",
                channel: "C_TEST",
                channel_type: "channel",
                user: "U_TEST",
                thread_ts: threadTs,
                ts,
                text: "thread reply",
              },
            }),
          );
        }

        await vi.waitFor(() => expect(starts).toHaveLength(2), { timeout: 500 });
        expect(starts).toEqual(["1700000000.000100", "1700000000.000200"]);
      } finally {
        releaseFirstDispatch();
        await ingress.waitForIdle();
        await ingress.stop();
      }
    });
  });

  it("serializes top-level channel messages by their authoritative session", async () => {
    const firstEvent = { ts: "1700000000.000100" };
    const secondEvent = { ts: "1700000000.000200" };
    await withQueue(async (queue) => {
      let releaseFirstDispatch: () => void = () => {};
      const firstDispatchGate = new Promise<void>((resolve) => {
        releaseFirstDispatch = resolve;
      });
      const starts: string[] = [];
      const processEvent = vi.fn(async (receiverEvent: ReceiverEvent) => {
        const event = (receiverEvent.body as { event: { ts: string } }).event;
        const lifecycle = resolveSlackIngressTurnLifecycle(receiverEvent.customProperties);
        await lifecycle?.onSessionRouted?.("agent:main:slack:shared-session");
        starts.push(event.ts);
        if (event.ts === firstEvent.ts) {
          await firstDispatchGate;
        }
        await lifecycle?.onAdopted();
      });
      const { ingress, receive } = attachIngress(queue, processEvent);
      ingress.start();

      try {
        for (const [eventId, event] of [
          ["Ev-shared-first", firstEvent],
          ["Ev-shared-second", secondEvent],
        ] as const) {
          await receive(
            createReceiverEvent(eventId, undefined, {
              event: {
                type: "message",
                channel: "C_TEST",
                channel_type: "channel",
                user: "U_TEST",
                text: "shared session",
                ...event,
              },
            }),
          );
        }

        await vi.waitFor(() => expect(processEvent).toHaveBeenCalledTimes(2), { timeout: 500 });
        expect(starts).toEqual([firstEvent.ts]);
        releaseFirstDispatch();
        await ingress.waitForIdle();
        expect(starts).toEqual([firstEvent.ts, secondEvent.ts]);
      } finally {
        releaseFirstDispatch();
        await ingress.waitForIdle();
        await ingress.stop();
      }
    });
  });

  it("keeps a queued same-session event alive past the adoption watchdog", async () => {
    await withQueue(async (queue) => {
      let releaseFirstSettlement: () => void = () => {};
      const firstSettlement = new Promise<void>((resolve) => {
        releaseFirstSettlement = resolve;
      });
      const starts: string[] = [];
      const processEvent = vi.fn(async (receiverEvent: ReceiverEvent) => {
        const eventId = (receiverEvent.body as { event_id: string }).event_id;
        const lifecycle = resolveSlackIngressTurnLifecycle(receiverEvent.customProperties);
        await lifecycle?.onSessionRouted?.("agent:main:slack:shared-session");
        starts.push(eventId);
        if (eventId === "Ev-session-watchdog-first") {
          (lifecycle as ChannelIngressMonitorLifecycle).onAdoptionFinalizing();
          await firstSettlement;
        }
        await lifecycle?.onAdopted();
      });
      const { ingress, receive } = attachIngress(queue, processEvent, {
        adoptionStallTimeoutMs: 80,
      });
      ingress.start();

      try {
        await receive(createReceiverEvent("Ev-session-watchdog-first"));
        await receive(createReceiverEvent("Ev-session-watchdog-second"));
        await vi.waitFor(() => expect(processEvent).toHaveBeenCalledTimes(2));
        expect(starts).toEqual(["Ev-session-watchdog-first"]);

        await new Promise<void>((resolve) => {
          setTimeout(resolve, 120);
        });
        await receive(createReceiverEvent("Ev-session-watchdog-third"));
        await vi.waitFor(() => expect(processEvent).toHaveBeenCalledTimes(3));
        expect((await queue.listClaims()).map((claim) => claim.id)).toEqual([
          "Ev-session-watchdog-first",
          "Ev-session-watchdog-second",
          "Ev-session-watchdog-third",
        ]);
        expect(starts).toEqual(["Ev-session-watchdog-first"]);

        releaseFirstSettlement();
        await ingress.waitForIdle();
        expect(starts).toEqual([
          "Ev-session-watchdog-first",
          "Ev-session-watchdog-second",
          "Ev-session-watchdog-third",
        ]);
        expect(processEvent).toHaveBeenCalledTimes(3);
        expect(await queue.listPending()).toEqual([]);
      } finally {
        releaseFirstSettlement();
        await ingress.waitForIdle();
        await ingress.stop();
      }
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
            channel_type: "channel",
            user: "U_TEST",
            ts: "1700000000.000200",
            thread_ts: "1700000000.000100",
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

  it("serializes channel-ID migration behind a deferred message through Bolt", async () => {
    await withQueue(async (queue) => {
      const messageStarted = createDeferred<void>();
      const messageGate = createDeferred<void>();
      const migrationGate = createDeferred<void>();
      const starts: string[] = [];
      const ingress = createSlackDurableIngress({
        accountId: "default",
        queue,
        pollIntervalMs: 60_000,
        adoptionStallTimeoutMs: 5_000,
      });
      const harness = createReceiverHarness();
      const app = new App({
        receiver: ingress.wrapReceiver(harness.receiver),
        authorize: async () => ({
          botToken: "xoxb-test",
          botId: "B_BOT",
          botUserId: "U_BOT",
          teamId: "T_TEST",
        }),
        convoStore: false,
        ignoreSelf: false,
      });
      app.event("message", async ({ context }) => {
        const lifecycle = resolveSlackIngressTurnLifecycle(context);
        await lifecycle?.onSessionRouted?.("agent:main:slack:thread:C_NEW");
        starts.push("message");
        lifecycle?.onDeferred();
        messageStarted.resolve();
        await messageGate.promise;
        await lifecycle?.onAdopted();
      });
      app.event("channel_id_changed", async ({ context }) => {
        starts.push("channel_id_changed");
        await migrationGate.promise;
        await resolveSlackIngressTurnLifecycle(context)?.onAdopted();
      });
      ingress.start();

      try {
        await harness.receive(
          createReceiverEventWithBody({
            ...createSlackEnvelope("Ev-routed-before-migration"),
            event: {
              type: "message",
              channel: "C_NEW",
              channel_type: "channel",
              user: "U_TEST",
              ts: "1700000000.000200",
              thread_ts: "1700000000.000100",
              text: "before migration",
            },
          }),
        );
        await messageStarted.promise;
        await harness.receive(
          createReceiverEventWithBody(
            createChannelIdChangedEnvelope("Ev-migration-after-route", "C_OLD", "C_NEW"),
          ),
        );
        await vi.waitFor(async () => {
          expect((await queue.listClaims()).map((claim) => claim.id)).toEqual([
            "Ev-routed-before-migration",
            "Ev-migration-after-route",
          ]);
        });
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(starts).toEqual(["message"]);

        messageGate.resolve();
        await vi.waitFor(() => expect(starts).toEqual(["message", "channel_id_changed"]));
      } finally {
        messageGate.resolve();
        migrationGate.resolve();
        await ingress.waitForIdle();
        await ingress.stop();
      }
    });
  });

  it("preserves repeated member occurrences through Bolt while deduping Slack retries", async () => {
    await withQueue(async (queue) => {
      const trackEvent = vi.fn();
      const { ingress, receive } = attachBoltMemberIngress({ queue, trackEvent });
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

        expect(trackEvent).toHaveBeenCalledTimes(3);
        expect(
          peekSystemEventEntries("agent:main:slack:channel:c_test").map(
            (entry) => entry.contextKey,
          ),
        ).toEqual([
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
      const trackEvent = vi.fn();
      let usersInfoRequests = 0;
      const usersInfoFetch = vi.fn<NonNullable<WebClientOptions["fetch"]>>(async (input) => {
        const pathname = new URL(String(input)).pathname;
        if (pathname.endsWith("/conversations.info")) {
          return Response.json({
            ok: true,
            channel: { id: "C_TEST", name: "general", is_channel: true },
          });
        }
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
      const first = attachBoltMemberIngress({ queue, trackEvent, usersInfoFetch });
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

        expect(trackEvent).toHaveBeenCalledTimes(1);
        expect(peekSystemEventEntries("agent:main:slack:channel:c_test")).toHaveLength(0);
        expect((await queue.listPending()).map((entry) => entry.id)).toContain("Ev-member-retry");

        restarted = attachBoltMemberIngress({
          queue,
          trackEvent,
          usersInfoFetch,
          pollIntervalMs: 25,
        });
        restarted.ingress.start();
        await vi.waitFor(
          async () => {
            await restarted?.ingress.waitForIdle();
            expect(trackEvent).toHaveBeenCalledTimes(2);
          },
          { timeout: 15_000, interval: 100 },
        );

        expect(usersInfoRequests).toBe(2);
        expect(peekSystemEventEntries("agent:main:slack:channel:c_test")).toHaveLength(1);
      } finally {
        await first.ingress.stop();
        await restarted?.ingress.stop();
      }
    });
  });
});

describe("Slack deferred ingress shutdown", () => {
  it("settles a failed session-routed delivery before shutdown without losing retry facts", async () => {
    await withBoltQueue(async (queue) => {
      const processEvent = vi.fn(async (event: ReceiverEvent) => {
        const lifecycle = resolveSlackIngressTurnLifecycle(event.customProperties);
        await lifecycle?.onSessionRouted?.("agent:main:slack:failed-session");
        throw new Error("session dispatch failed");
      });
      const { app, ingress, receive } = attachBoltIngress(queue, { adoptionStallTimeoutMs: 5_000 });
      vi.spyOn(app, "processEvent").mockImplementation(processEvent);
      ingress.start();
      try {
        await receive(createBoltReceiverEvent("Ev-failed-session"));
        await ingress.waitForIdle();
        await ingress.stop();
        expect(await queue.listPending()).toEqual([
          expect.objectContaining({
            id: "Ev-failed-session",
            attempts: 1,
            lastError: "session dispatch failed",
          }),
        ]);
        expect(await queue.listClaims()).toEqual([]);
      } finally {
        await ingress.stop();
      }
    });
  });

  it("joins a deferred reply's replay settlement after its Bolt handler returns", async () => {
    await withBoltQueue(async (queue) => {
      const commitStarted = createDeferred<void>();
      const commitGate = createDeferred<void>();
      let settlement: Promise<void> | undefined;
      const processEvent = vi.fn(async (event: ReceiverEvent) => {
        const lifecycle = resolveSlackIngressTurnLifecycle(event.customProperties);
        if (!lifecycle) {
          throw new Error("Missing Slack ingress lifecycle");
        }
        await lifecycle.onSessionRouted?.("agent:main:slack:deferred-stop");
        lifecycle.onDeferred();
        settlement = (async () => {
          commitStarted.resolve();
          await commitGate.promise;
          await lifecycle.onAdopted();
        })();
      });
      const { app, ingress, receive } = attachBoltIngress(queue, { adoptionStallTimeoutMs: 5_000 });
      vi.spyOn(app, "processEvent").mockImplementation(processEvent);
      ingress.start();
      let stopped = false;
      let stop: Promise<void> | undefined;
      try {
        await receive(createBoltReceiverEvent("Ev-deferred-settlement"));
        await commitStarted.promise;
        await ingress.waitForIdle();
        stop = ingress.stop().then(() => {
          stopped = true;
        });
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(stopped).toBe(false);
        commitGate.resolve();
        await settlement;
        await stop;
        expect(stopped).toBe(true);
      } finally {
        commitGate.resolve();
        await settlement;
        await (stop ?? ingress.stop());
      }
    });
  });
});

describe("Slack relay durable ingress", () => {
  const relayMessage = {
    type: "message",
    channel: "C_RELAY",
    team: "T_TEST",
    user: "U_TEST",
    ts: "1700000001.000200",
    text: "relayed",
  };

  it("retries a claimed relay event until a dispatcher attaches", async () => {
    await withBoltQueue(async (queue) => {
      const detached = createSlackDurableIngress({
        accountId: "default",
        queue,
        pollIntervalMs: 60_000,
        adoptionStallTimeoutMs: 5_000,
      });
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

  it("drops a malformed persisted row without blocking the next relay message", async () => {
    await withBoltQueue(async (queue) => {
      const laneKey = "team:T_TEST:conversation:C_RELAY";
      await queue.enqueue(
        "relay:malformed",
        {
          version: 1,
          receivedAt: 1,
          kind: "relay",
          message: { channel: "C_RELAY", team: "T_TEST" },
        },
        { laneKey, receivedAt: 1 },
      );
      await queue.enqueue(
        "message:T_TEST:C_RELAY:1700000001.000200",
        { version: 1, receivedAt: 2, kind: "relay", message: relayMessage },
        { laneKey, receivedAt: 2 },
      );

      const dispatched: unknown[] = [];
      const ingress = createSlackDurableIngress({ accountId: "default", queue });
      ingress.attachRelayDispatch(async (message) => {
        dispatched.push(message);
      });
      ingress.start();
      await ingress.waitForIdle();

      expect(dispatched).toEqual([relayMessage]);
      expect(await queue.listPending()).toHaveLength(0);
      await ingress.stop();
    });
  });
});
