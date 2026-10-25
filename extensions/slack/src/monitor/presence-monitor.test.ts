import { WebAPIRateLimitedError } from "@slack/web-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createTestPluginServiceScheduler,
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPresenceStore } from "../../../test-support/presence-store.js";
import type { PreparedSlackMessage } from "./message-handler/types.js";
import {
  createSlackPresenceMonitor,
  hasSlackPresenceEventsEnabled,
  SLACK_PRESENCE_REQUEST_TIMEOUT_MS,
} from "./presence-monitor.js";

type PresenceSystem = Parameters<typeof createSlackPresenceMonitor>[0]["system"];

function createReceipt(accepted = true): ReturnType<PresenceSystem["enqueueSessionEvent"]> {
  return {
    id: "presence",
    cancel: () => false,
    accepted: Promise.resolve(accepted ? { ok: true } : { ok: false, error: "session replaced" }),
    settled: Promise.resolve({
      status: accepted ? "completed" : "failed",
      executionStarted: accepted,
      delivered: accepted,
      ...(!accepted ? { error: "session replaced" } : {}),
    }),
  };
}

function createCaptureTarget() {
  return vi.fn(createPluginRuntimeMock().system.captureSessionEventTarget);
}

const presenceFixtures = new Set<ReturnType<typeof createSlackPresenceMonitor>>();
afterEach(async () => {
  await Promise.all(Array.from(presenceFixtures, (monitor) => monitor.stop()));
  presenceFixtures.clear();
});

function createPresenceFixture(
  params: Partial<Omit<Parameters<typeof createSlackPresenceMonitor>[0], "scheduler">> & {
    clock?: ReturnType<typeof createGatewaySchedulerClock>;
    getPresence?: ReturnType<typeof presenceSequence>;
    enqueue?: ReturnType<typeof vi.fn<PresenceSystem["enqueueSessionEvent"]>>;
    captureTarget?: ReturnType<typeof createCaptureTarget>;
  } = {},
) {
  const {
    clock = createGatewaySchedulerClock(),
    getPresence = presenceSequence("away", "active"),
    enqueue = vi.fn<PresenceSystem["enqueueSessionEvent"]>(() => createReceipt()),
    captureTarget = createCaptureTarget(),
    ...options
  } = params;
  const scheduler = createTestPluginServiceScheduler(createTestGatewayScheduler(clock.clock));
  const cooldownStore = createCooldownStore();
  const monitor = createSlackPresenceMonitor({
    accountId: "default",
    accountConfig: { mode: "auto" },
    cooldownStore,
    system: { enqueueSessionEvent: enqueue, captureSessionEventTarget: captureTarget },
    resolveClient: () => ({ getPresence }),
    ...options,
    scheduler,
  });
  presenceFixtures.add(monitor);
  monitor.start();
  return {
    ...monitor,
    enqueue,
    captureTarget,
    cooldownStore,
    getPresence,
    advancePoll: () => Promise.resolve(clock.wake()),
    pollAt: async (...times: number[]) => {
      for (const time of times) {
        clock.setTime(time);
        await clock.wake();
      }
    },
  };
}

function presenceSequence(...samples: string[]) {
  const getPresence = vi.fn();
  for (const presence of samples) {
    getPresence.mockResolvedValueOnce({ presence });
  }
  return getPresence;
}

function createCooldownStore() {
  return {
    ...createPresenceStore(),
    entries: async () => [],
  };
}

function createPrepared({
  userId,
  teamId,
  channelId = "D123",
  channelType = "im",
  threadId,
  mode,
  prompt,
  sessionKey = `agent:main:slack:channel:${channelId}`,
}: {
  userId: string;
  teamId?: string;
  channelId?: string;
  channelType?: "im" | "mpim" | "channel" | "group";
  threadId?: string;
  mode?: "off" | "auto" | "on";
  prompt?: string;
  sessionKey?: string;
}): PreparedSlackMessage {
  return {
    ctx: { isRuntimePolicyCurrent: () => true },
    message: { type: "message", user: userId, channel: channelId, channel_type: channelType },
    ...(teamId ? { eventScope: { teamId, client: {} as never } } : {}),
    route: { agentId: "main", accountId: "default", sessionKey },
    channelConfig:
      mode || prompt !== undefined
        ? { allowed: true, requireMention: false, presenceEvents: { mode, prompt } }
        : null,
    ctxPayload: { MessageThreadId: threadId },
    isDirectMessage: channelType === "im",
  } as PreparedSlackMessage;
}

describe("Slack presence monitor", () => {
  it("joins an active scheduled poll when its account lifetime retires", async () => {
    vi.useFakeTimers();
    const scheduler = createTestPluginServiceScheduler();
    const response = createDeferred<{ presence: string }>();
    const getPresence = vi.fn().mockReturnValue(response.promise);
    const enqueue = vi.fn<PresenceSystem["enqueueSessionEvent"]>(() => createReceipt());
    const monitor = createSlackPresenceMonitor({
      scheduler,
      accountId: "default",
      accountConfig: { mode: "auto" },
      resolveClient: () => ({ getPresence }),
      cooldownStore: createCooldownStore(),
      system: { enqueueSessionEvent: enqueue, captureSessionEventTarget: createCaptureTarget() },
    });
    try {
      monitor.observe(createPrepared({ userId: "U123" }));
      monitor.start();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(getPresence).toHaveBeenCalledOnce();
      const stopped = vi.fn();
      const stopping = scheduler.stop().then(stopped);
      await Promise.resolve();
      expect(stopped).not.toHaveBeenCalled();
      response.resolve({ presence: "active" });
      await stopping;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(getPresence).toHaveBeenCalledOnce();
      expect(enqueue).not.toHaveBeenCalled();
    } finally {
      response.resolve({ presence: "active" });
      await scheduler.stop();
      vi.useRealTimers();
    }
  });

  it("retires an old policy target while its presence request is in flight", async () => {
    let current = true;
    const response = createDeferred<{ presence: string }>();
    const getPresence = vi
      .fn()
      .mockResolvedValueOnce({ presence: "away" })
      .mockReturnValueOnce(response.promise);
    const monitor = createPresenceFixture({ getPresence });
    const { enqueue, cooldownStore } = monitor;
    const prepared = createPrepared({ userId: "U123" });
    prepared.ctx.isRuntimePolicyCurrent = () => current;
    monitor.observe(prepared);
    await monitor.advancePoll();
    const pending = monitor.advancePoll();
    current = false;
    response.resolve({ presence: "active" });
    await pending;
    expect(enqueue).not.toHaveBeenCalled();
    expect(await cooldownStore.lookup("default:workspace:U123")).toBeUndefined();
    await monitor.advancePoll();
    expect(getPresence).toHaveBeenCalledTimes(2);
  });

  it("stays disabled when presence config is absent or explicitly off", () => {
    expect(hasSlackPresenceEventsEnabled({})).toBe(false);
    expect(hasSlackPresenceEventsEnabled({ account: { mode: "off" } })).toBe(false);
    expect(
      hasSlackPresenceEventsEnabled({
        account: { mode: "off" },
        channels: { C123: { presenceEvents: { mode: "auto" } } },
      }),
    ).toBe(true);
  });

  it.each(["Do not send a greeting.", ""])(
    "replaces default guidance with configured prompt %j",
    async (prompt) => {
      const clock = createGatewaySchedulerClock(2_000);
      const monitor = createPresenceFixture({
        clock,
        accountConfig: { mode: "auto", prompt: "Account guidance" },
      });
      monitor.observe(createPrepared({ userId: "U123", mode: "auto", prompt }));
      await monitor.advancePoll();
      await monitor.pollAt(7_500);
      expect(monitor.enqueue.mock.calls[0]?.[0]).toBe(
        [
          "Slack presence event:",
          'A human participant became active on Slack after being observed away: user_id="U123" channel_id="D123".',
          "observed_away_at_ms=2000 observed_active_at_ms=7500 observed_away_duration_ms=5500",
          ...(prompt ? [prompt] : []),
        ].join("\n"),
      );
    },
  );

  it("seeds the first sample and submits only on away-to-active", async () => {
    const clock = createGatewaySchedulerClock(1_000);
    const getPresence = presenceSequence("active", "away", "away", "active", "away", "active");
    const monitor = createPresenceFixture({ clock, getPresence });
    const { enqueue } = monitor;
    monitor.observe(createPrepared({ userId: "U123" }));

    await monitor.advancePoll();
    await monitor.pollAt(2_000);
    expect(enqueue).not.toHaveBeenCalled();

    await monitor.pollAt(4_000);
    expect(enqueue).not.toHaveBeenCalled();

    await monitor.pollAt(7_500);
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(
      [
        "Slack presence event:",
        'A human participant became active on Slack after being observed away: user_id="U123" channel_id="D123".',
        "observed_away_at_ms=2000 observed_active_at_ms=7500 observed_away_duration_ms=5500",
        "Before greeting, retrieve relevant memory and wiki context for this immutable user_id, including a known timezone when available. Use their local time; if their timezone is unknown, do not guess.",
        "Send at most one short, natural greeting in this Slack conversation. Do not reveal private memory. If no greeting is appropriate, stay silent.",
      ].join("\n"),
      expect.objectContaining({
        agentId: "main",
        sessionKey: "agent:main:slack:channel:D123",
        deliveryContext: { channel: "slack", to: "user:U123", accountId: "default" },
      }),
    );
    expect(monitor.captureTarget).toHaveBeenCalledOnce();

    await monitor.pollAt(8_000, 9_000);
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("routes a transition only to the participant's newest eligible thread", async () => {
    const clock = createGatewaySchedulerClock(1);
    const getPresence = presenceSequence("away", "away", "active", "away");
    const monitor = createPresenceFixture({ clock, getPresence });
    const observeThread = (
      userId: string,
      channelId: string,
      threadId: string,
      sessionKey: string,
    ) =>
      monitor.observe(
        createPrepared({ userId, channelId, channelType: "channel", threadId, sessionKey }),
      );
    observeThread("U123", "COLD", "1.000", "session:old");
    clock.setTime(2);
    observeThread("U123", "CNEW", "2.000", "session:new");
    clock.setTime(3);
    observeThread("UOTHER", "COLD", "1.000", "session:old");

    await monitor.advancePoll();
    await monitor.advancePoll();

    expect(monitor.enqueue).toHaveBeenCalledWith(
      expect.stringContaining('channel_id="CNEW"'),
      expect.objectContaining({
        agentId: "main",
        sessionKey: "session:new",
        deliveryContext: expect.objectContaining({
          to: "channel:CNEW",
          threadId: "2.000",
        }),
      }),
    );
  });

  it("isolates Enterprise presence clients, state, cooldowns, and delivery by workspace", async () => {
    const presenceByTeam = new Map(
      ["T11111111", "T22222222"].map((team) => [team, presenceSequence("away", "active")]),
    );
    const resolveClient = vi.fn((teamId?: string) => {
      const getPresence = presenceByTeam.get(teamId ?? "");
      if (!getPresence) {
        throw new Error(`unexpected team ${teamId}`);
      }
      return { getPresence };
    });
    const monitor = createPresenceFixture({ accountId: "org", resolveClient });
    monitor.observe(createPrepared({ userId: "U12345678", teamId: "T11111111" }));
    monitor.observe(createPrepared({ userId: "U12345678", teamId: "T22222222" }));

    await monitor.advancePoll();
    await monitor.advancePoll();

    expect(monitor.enqueue).toHaveBeenCalledTimes(2);
    for (const teamId of ["T11111111", "T22222222"]) {
      expect(resolveClient).toHaveBeenCalledWith(teamId);
      expect(monitor.enqueue).toHaveBeenCalledWith(
        expect.stringContaining(`team_id="${teamId}"`),
        expect.objectContaining({
          agentId: "main",
          deliveryContext: expect.objectContaining({ to: `team:${teamId}:user:U12345678` }),
        }),
      );
    }
  });

  it("does not let excluded auto channels evict an eligible direct message", async () => {
    const getPresence = vi.fn().mockResolvedValue({ presence: "away" });
    const monitor = createPresenceFixture({ getPresence });
    monitor.observe(createPrepared({ userId: "UDIRECT" }));
    for (let index = 0; index < 2_001; index += 1) {
      monitor.observe(
        createPrepared({
          userId: `UTOP${index}`,
          channelId: `C${index}`,
          channelType: "channel",
        }),
      );
    }

    await monitor.advancePoll();

    expect(getPresence).toHaveBeenCalledExactlyOnceWith({ user: "UDIRECT" });
  });

  it.each(["continue", "stop"] as const)(
    "bounds a stalled request when the poll must %s",
    async (action) => {
      vi.useFakeTimers();
      const stalled = createDeferred<{ presence: string }>();
      let polling: Promise<void> | undefined;
      try {
        const getPresence = vi
          .fn()
          .mockReturnValueOnce(stalled.promise)
          .mockResolvedValueOnce({ presence: "away" });
        const monitor = createPresenceFixture({ getPresence });
        monitor.observe(createPrepared({ userId: "U1", channelId: "D1" }));
        if (action === "continue") {
          monitor.observe(createPrepared({ userId: "U2", channelId: "D2" }));
        }
        polling = monitor.advancePoll();
        const stopping = action === "stop" ? monitor.stop() : undefined;
        const settled = vi.fn();
        void (stopping ?? polling).then(settled);
        await vi.advanceTimersByTimeAsync(SLACK_PRESENCE_REQUEST_TIMEOUT_MS);
        expect(settled).toHaveBeenCalledOnce();
        await Promise.all([polling, stopping]);
        expect(getPresence).toHaveBeenNthCalledWith(1, { user: "U1" });
        if (action === "continue") {
          expect(getPresence).toHaveBeenNthCalledWith(2, { user: "U2" });
        } else {
          expect(getPresence).toHaveBeenCalledOnce();
        }
      } finally {
        stalled.resolve({ presence: "away" });
        await polling;
        vi.useRealTimers();
      }
    },
  );

  it("honors Slack Retry-After without skipping the unpolled page", async () => {
    const clock = createGatewaySchedulerClock(1_000);
    const getPresence = vi
      .fn()
      .mockRejectedValueOnce(new WebAPIRateLimitedError(120))
      .mockResolvedValue({ presence: "away" });
    const monitor = createPresenceFixture({
      clock,
      accountConfig: { mode: "on" },
      getPresence,
    });
    for (let index = 1; index <= 46; index += 1) {
      monitor.observe(createPrepared({ userId: `U${String(index).padStart(4, "0")}` }));
    }

    await monitor.advancePoll();
    expect(getPresence).toHaveBeenCalledExactlyOnceWith({ user: "U0001" });

    await monitor.pollAt(120_999);
    expect(getPresence).toHaveBeenCalledTimes(1);

    await monitor.pollAt(121_000);
    expect(getPresence).toHaveBeenNthCalledWith(2, { user: "U0001" });
    expect(getPresence).toHaveBeenNthCalledWith(3, { user: "U0002" });
    expect(getPresence).toHaveBeenCalledTimes(46);

    await monitor.advancePoll();
    expect(getPresence).toHaveBeenNthCalledWith(47, { user: "U0046" });
  });

  it.each(["retarget", "stop", "ineligible", "expired", "replaced"] as const)(
    "waits for cooldown persistence and drains cleanup when %s",
    async (outcome) => {
      const reservation = createDeferred<boolean>();
      const reservationStarted = createDeferred<void>();
      const cleanup = createDeferred<boolean>();
      const cleanupStarted = createDeferred<void>();
      const cooldownStore = createCooldownStore();
      cooldownStore.registerIfAbsent = async (key, value) => {
        await cooldownStore.register(key, value);
        reservationStarted.resolve();
        return reservation.promise;
      };
      const deleteEntry = cooldownStore.delete.bind(cooldownStore);
      cooldownStore.delete = async (key) => {
        cleanupStarted.resolve();
        await cleanup.promise;
        return await deleteEntry(key);
      };
      const deleteIfEqual = cooldownStore.deleteIfEqual.bind(cooldownStore);
      cooldownStore.deleteIfEqual = async (key, expected) => {
        cleanupStarted.resolve();
        await cleanup.promise;
        return await deleteIfEqual(key, expected);
      };
      const enqueue = vi.fn<PresenceSystem["enqueueSessionEvent"]>(() =>
        createReceipt(outcome !== "replaced"),
      );
      const clock = createGatewaySchedulerClock(1_000);
      const monitor = createPresenceFixture({
        clock,
        cooldownStore,
        enqueue,
      });
      const { captureTarget } = monitor;
      monitor.observe(createPrepared({ userId: "U123" }));
      await monitor.advancePoll();
      const polling = monitor.advancePoll();
      await reservationStarted.promise;
      expect(enqueue).not.toHaveBeenCalled();
      expect(captureTarget).toHaveBeenCalledExactlyOnceWith(
        "main",
        "agent:main:slack:channel:D123",
      );
      await monitor.advancePoll();
      expect(monitor.getPresence).toHaveBeenCalledTimes(2);
      let stopping: Promise<void> | undefined;
      let stopSettled = false;
      if (outcome === "stop") {
        stopping = monitor.stop().then(() => {
          stopSettled = true;
        });
      } else if (outcome === "ineligible") {
        for (let index = 0; index < 8; index += 1) {
          monitor.observe(createPrepared({ userId: `UOTHER${index}` }));
        }
      } else if (outcome === "expired") {
        clock.setTime(1_000 + 24 * 60 * 60 * 1_000);
      } else if (outcome === "retarget") {
        clock.setTime(1_001);
        monitor.observe(
          createPrepared({ userId: "U123", channelId: "DNEW", sessionKey: "session:new" }),
        );
      }
      reservation.resolve(true);
      await cleanupStarted.promise;
      stopping ??= monitor.stop().then(() => {
        stopSettled = true;
      });
      await Promise.resolve();
      expect(stopSettled).toBe(false);
      if (outcome === "replaced") {
        await cooldownStore.register("default:workspace:U123", 1_001);
      }
      cleanup.resolve(true);
      await polling;
      await stopping;
      expect(stopSettled).toBe(true);
      expect(enqueue).toHaveBeenCalledTimes(outcome === "replaced" ? 1 : 0);
      expect(await cooldownStore.lookup("default:workspace:U123")).toBe(
        outcome === "replaced" ? 1_001 : undefined,
      );
      expect(captureTarget).toHaveBeenCalledOnce();
    },
  );

  it("does not publish when cooldown persistence rejects", async () => {
    const cooldownStore = createCooldownStore();
    cooldownStore.registerIfAbsent = vi.fn().mockRejectedValue(new Error("storage unavailable"));
    const error = vi.fn();
    const monitor = createPresenceFixture({ cooldownStore, error });
    const { enqueue } = monitor;
    monitor.observe(createPrepared({ userId: "U123" }));
    await monitor.advancePoll();
    await monitor.advancePoll();
    expect(enqueue).not.toHaveBeenCalled();
    expect(monitor.captureTarget).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("cooldown persistence failed"));
  });

  it.each(["stop", "policy", "retarget", "capture-refused"] as const)(
    "does not reserve or submit after target capture when %s",
    async (outcome) => {
      const captured =
        createDeferred<Awaited<ReturnType<PresenceSystem["captureSessionEventTarget"]>>>();
      const started = createDeferred<void>();
      const captureTarget = createCaptureTarget().mockImplementationOnce(() => {
        started.resolve();
        return captured.promise;
      });
      const clock = createGatewaySchedulerClock(1_000);
      const monitor = createPresenceFixture({ clock, captureTarget });
      let current = true;
      const prepared = createPrepared({ userId: "U123" });
      prepared.ctx.isRuntimePolicyCurrent = () => current;
      monitor.observe(prepared);
      await monitor.advancePoll();
      const polling = monitor.advancePoll();
      await started.promise;
      let stopping: Promise<void> | undefined;
      if (outcome === "stop") {
        stopping = monitor.stop();
      } else if (outcome === "policy") {
        current = false;
      } else if (outcome === "retarget") {
        clock.setTime(1_001);
        monitor.observe(createPrepared({ userId: "U123", channelId: "DNEW", sessionKey: "new" }));
      }
      if (outcome === "capture-refused") {
        captured.reject(new Error("runtime retired"));
      } else {
        captured.resolve(await createCaptureTarget()("main", prepared.route.sessionKey));
      }
      await polling;
      await stopping;
      expect(monitor.enqueue).not.toHaveBeenCalled();
      expect(await monitor.cooldownStore.lookup("default:workspace:U123")).toBeUndefined();
    },
  );

  it("carries account cancellation through acceptance and reports failed settlement", async () => {
    const accepted =
      createDeferred<Awaited<ReturnType<PresenceSystem["enqueueSessionEvent"]>["accepted"]>>();
    const settled =
      createDeferred<Awaited<ReturnType<PresenceSystem["enqueueSessionEvent"]>["settled"]>>();
    const enqueued = createDeferred<void>();
    const enqueue = vi.fn<PresenceSystem["enqueueSessionEvent"]>(() => {
      enqueued.resolve();
      return {
        id: "presence",
        cancel: () => false,
        accepted: accepted.promise,
        settled: settled.promise,
      };
    });
    const error = vi.fn();
    const monitor = createPresenceFixture({ enqueue, error });
    monitor.observe(createPrepared({ userId: "U123" }));
    await monitor.advancePoll();
    const polling = monitor.advancePoll();
    await enqueued.promise;
    const options = enqueue.mock.calls[0]?.[1];
    expect(options?.expectedTarget).toBe(await monitor.captureTarget.mock.results[0]?.value);
    expect(options?.createIfMissing).toBeUndefined();
    expect(options?.abortSignal?.aborted).toBe(false);
    const stopping = monitor.stop();
    expect(options?.abortSignal?.aborted).toBe(true);
    accepted.resolve({ ok: true });
    await polling;
    await stopping;
    settled.resolve({ status: "cancelled", executionStarted: false, delivered: false });
    await settled.promise;
    await Promise.resolve();
    expect(error).toHaveBeenCalledWith("slack presence follow-up cancelled: cancelled");
    expect(await monitor.cooldownStore.lookup("default:workspace:U123")).toBeDefined();
  });

  it("quiesces an in-flight poll before stop returns", async () => {
    const active = createDeferred<{ presence: string }>();
    const getPresence = vi
      .fn()
      .mockResolvedValueOnce({ presence: "away" })
      .mockReturnValueOnce(active.promise);
    const monitor = createPresenceFixture({ getPresence });
    monitor.observe(createPrepared({ userId: "U123" }));
    await monitor.advancePoll();

    const polling = monitor.advancePoll();
    const stopping = monitor.stop();
    active.resolve({ presence: "active" });
    await Promise.all([polling, stopping]);

    expect(monitor.enqueue).not.toHaveBeenCalled();
  });
});
