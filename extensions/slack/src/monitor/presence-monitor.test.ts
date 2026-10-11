import { WebAPIRateLimitedError } from "@slack/web-api";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createTestPluginServiceScheduler,
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PreparedSlackMessage } from "./message-handler/types.js";
import {
  createSlackPresenceMonitor,
  hasSlackPresenceEventsEnabled,
  SLACK_PRESENCE_REQUEST_TIMEOUT_MS,
} from "./presence-monitor.js";

const presenceFixtures = new Set<ReturnType<typeof createSlackPresenceMonitor>>();
afterEach(async () => {
  await Promise.all(Array.from(presenceFixtures, (monitor) => monitor.stop()));
  presenceFixtures.clear();
});

function createPresenceFixture(
  params: Omit<Parameters<typeof createSlackPresenceMonitor>[0], "scheduler">,
  clock = createGatewaySchedulerClock(),
) {
  const scheduler = createTestPluginServiceScheduler(createTestGatewayScheduler(clock.clock));
  const monitor = createSlackPresenceMonitor({ ...params, scheduler });
  presenceFixtures.add(monitor);
  monitor.start();
  return { ...monitor, advancePoll: () => Promise.resolve(clock.wake()) };
}

const AUTO_MAX_PARTICIPANTS = 8;
const captureTarget = createPluginRuntimeMock().system.captureSessionEventTarget;

function completedReceipt(..._args: unknown[]) {
  return {
    id: "presence",
    accepted: Promise.resolve({ ok: true as const }),
    cancel: vi.fn(),
    settled: Promise.resolve({
      status: "completed" as const,
      executionStarted: true,
      delivered: true,
    }),
  };
}

function createCooldownStore() {
  const values = new Map<string, number>();
  return {
    register: async (key, value) => void values.set(key, value),
    registerIfAbsent: async (key, value) => {
      if (values.has(key)) {
        return false;
      }
      values.set(key, value);
      return true;
    },
    lookup: async (key) => values.get(key),
    consume: async (key) => {
      const value = values.get(key);
      values.delete(key);
      return value;
    },
    delete: async (key) => values.delete(key),
    deleteIfEqual: async (key, expected) => {
      const value = values.get(key);
      return value !== undefined && value === expected ? values.delete(key) : false;
    },
    entries: async () => [],
    clear: async () => values.clear(),
  } satisfies PluginStateKeyedStore<number>;
}

function createPrepared(params: {
  userId: string;
  teamId?: string;
  channelId?: string;
  channelType?: "im" | "mpim" | "channel" | "group";
  threadId?: string;
  mode?: "off" | "auto" | "on";
  prompt?: string;
  sessionKey?: string;
}): PreparedSlackMessage {
  const channelId = params.channelId ?? "D123";
  const channelType = params.channelType ?? "im";
  return {
    ctx: { isRuntimePolicyCurrent: () => true },
    message: {
      type: "message",
      user: params.userId,
      channel: channelId,
      channel_type: channelType,
    },
    ...(params.teamId ? { eventScope: { teamId: params.teamId, client: {} as never } } : {}),
    route: {
      agentId: "main",
      accountId: "default",
      sessionKey: params.sessionKey ?? `agent:main:slack:channel:${channelId}`,
    },
    channelConfig:
      params.mode || params.prompt !== undefined
        ? {
            allowed: true,
            requireMention: false,
            presenceEvents: {
              ...(params.mode ? { mode: params.mode } : {}),
              ...(params.prompt !== undefined ? { prompt: params.prompt } : {}),
            },
          }
        : null,
    ctxPayload: {
      MessageThreadId: params.threadId,
    },
    isDirectMessage: channelType === "im",
  } as PreparedSlackMessage;
}

describe("Slack presence monitor", () => {
  it("joins an active scheduled poll when its account lifetime retires", async () => {
    vi.useFakeTimers();
    const scheduler = createTestPluginServiceScheduler();
    const response = createDeferred<{ presence: string }>();
    const getPresence = vi.fn().mockReturnValue(response.promise);
    const enqueue = vi.fn(completedReceipt);
    const monitor = createSlackPresenceMonitor({
      scheduler,
      accountId: "default",
      accountConfig: { mode: "auto" },
      client: { getPresence } as never,
      cooldownStore: createCooldownStore(),
      enqueue,
      captureTarget,
    });
    try {
      monitor.observe(createPrepared({ userId: "U123" }));
      monitor.start();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(getPresence).toHaveBeenCalledOnce();
      let stopped = false;
      const stopping = scheduler.stop().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);
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

  it.each(["presence", "target", "refresh"] as const)(
    "retires an old target during %s",
    async (stage) => {
      let current = true;
      const response = createDeferred<{ presence: string }>();
      const target = createDeferred<Awaited<ReturnType<typeof captureTarget>>>();
      const captureStarted = createDeferred<void>();
      const getPresence = vi
        .fn()
        .mockResolvedValueOnce({ presence: "away" })
        .mockReturnValueOnce(
          stage === "presence" ? response.promise : Promise.resolve({ presence: "active" }),
        );
      const enqueue = vi.fn(completedReceipt);
      const cooldownStore = createCooldownStore();
      const monitor = createPresenceFixture({
        accountId: "default",
        accountConfig: { mode: "auto" },
        client: { getPresence } as never,
        cooldownStore,
        enqueue,
        captureTarget:
          stage === "presence"
            ? captureTarget
            : () => {
                captureStarted.resolve();
                return target.promise;
              },
      });
      const prepared = createPrepared({ userId: "U123" });
      prepared.ctx.isRuntimePolicyCurrent = () => current;
      monitor.observe(prepared);
      await monitor.advancePoll();
      const pending = monitor.advancePoll();
      if (stage !== "presence") {
        await captureStarted.promise;
      }
      if (stage === "refresh") {
        monitor.observe(prepared);
      } else {
        current = false;
      }
      response.resolve({ presence: "active" });
      target.resolve(await captureTarget("main", prepared.route.sessionKey));
      await pending;
      expect(enqueue).not.toHaveBeenCalled();
      expect(await cooldownStore.lookup("default:workspace:U123")).toBeUndefined();
      current = false;
      await monitor.advancePoll();
      expect(getPresence).toHaveBeenCalledTimes(2);
    },
  );

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

  it("replaces only the default guidance with a configured prompt", async () => {
    const clock = createGatewaySchedulerClock(2_000);
    const getPresence = vi
      .fn()
      .mockResolvedValueOnce({ presence: "away" })
      .mockResolvedValueOnce({ presence: "active" });
    const enqueue = vi.fn(completedReceipt);
    const monitor = createPresenceFixture(
      {
        accountId: "default",
        accountConfig: { mode: "auto", prompt: "Account guidance" },
        client: { getPresence } as never,
        cooldownStore: createCooldownStore(),
        enqueue,
        captureTarget,
      },
      clock,
    );
    monitor.observe(
      createPrepared({ userId: "U123", mode: "auto", prompt: "Do not send a greeting." }),
    );

    await monitor.advancePoll();
    clock.setTime(7_500);
    await monitor.advancePoll();

    expect(enqueue.mock.calls[0]?.[0]).toBe(
      [
        "Slack presence event:",
        'A human participant became active on Slack after being observed away: user_id="U123" channel_id="D123".',
        "observed_away_at_ms=2000 observed_active_at_ms=7500 observed_away_duration_ms=5500",
        "Do not send a greeting.",
      ].join("\n"),
    );
  });

  it("allows empty prompt guidance so workspace instructions govern the event", async () => {
    const clock = createGatewaySchedulerClock(2_000);
    const getPresence = vi
      .fn()
      .mockResolvedValueOnce({ presence: "away" })
      .mockResolvedValueOnce({ presence: "active" });
    const enqueue = vi.fn(completedReceipt);
    const monitor = createPresenceFixture(
      {
        accountId: "default",
        accountConfig: { mode: "auto", prompt: "Account guidance" },
        client: { getPresence } as never,
        cooldownStore: createCooldownStore(),
        enqueue,
        captureTarget,
      },
      clock,
    );
    monitor.observe(createPrepared({ userId: "U123", mode: "auto", prompt: "" }));

    await monitor.advancePoll();
    clock.setTime(7_500);
    await monitor.advancePoll();

    expect(enqueue.mock.calls[0]?.[0]).toBe(
      [
        "Slack presence event:",
        'A human participant became active on Slack after being observed away: user_id="U123" channel_id="D123".',
        "observed_away_at_ms=2000 observed_active_at_ms=7500 observed_away_duration_ms=5500",
      ].join("\n"),
    );
  });

  it("seeds the first sample and emits an event only on away-to-active", async () => {
    const clock = createGatewaySchedulerClock(1_000);
    const getPresence = vi
      .fn()
      .mockResolvedValueOnce({ presence: "active" })
      .mockResolvedValueOnce({ presence: "away" })
      .mockResolvedValueOnce({ presence: "away" })
      .mockResolvedValueOnce({ presence: "active" })
      .mockResolvedValueOnce({ presence: "away" })
      .mockResolvedValueOnce({ presence: "active" });
    const enqueue = vi.fn(completedReceipt);
    const coldTarget = await captureTarget("main", "agent:main:slack:channel:D123");
    const initializedTarget = await captureTarget("main", "agent:main:slack:channel:D123");
    let currentTarget = coldTarget;
    const captureCurrentTarget = vi.fn(async () => currentTarget);
    const monitor = createPresenceFixture(
      {
        accountId: "default",
        accountConfig: { mode: "auto" },
        client: { getPresence } as never,
        cooldownStore: createCooldownStore(),
        enqueue,
        captureTarget: captureCurrentTarget,
      },
      clock,
    );
    monitor.observe(createPrepared({ userId: "U123" }));

    await monitor.advancePoll();
    clock.setTime(2_000);
    await monitor.advancePoll();
    expect(enqueue).not.toHaveBeenCalled();

    clock.setTime(4_000);
    await monitor.advancePoll();
    expect(enqueue).not.toHaveBeenCalled();

    // The first human turn creates its session after eligibility was observed.
    currentTarget = initializedTarget;
    clock.setTime(7_500);
    await monitor.advancePoll();
    expect(enqueue).toHaveBeenCalledOnce();
    expect(captureCurrentTarget).toHaveBeenCalledExactlyOnceWith(
      "main",
      "agent:main:slack:channel:D123",
    );
    expect(enqueue).toHaveBeenCalledWith(
      expect.stringMatching(
        /observed_away_at_ms=2000 observed_active_at_ms=7500 observed_away_duration_ms=5500/,
      ),
      expect.objectContaining({
        expectedTarget: initializedTarget,
        agentId: "main",
        sessionKey: "agent:main:slack:channel:D123",
        deliveryContext: {
          channel: "slack",
          to: "user:U123",
          accountId: "default",
        },
      }),
    );
    expect(enqueue.mock.calls[0]?.[0]).toBe(
      [
        "Slack presence event:",
        'A human participant became active on Slack after being observed away: user_id="U123" channel_id="D123".',
        "observed_away_at_ms=2000 observed_active_at_ms=7500 observed_away_duration_ms=5500",
        "Before greeting, retrieve relevant memory and wiki context for this immutable user_id, including a known timezone when available. Use their local time; if their timezone is unknown, do not guess.",
        "Send at most one short, natural greeting in this Slack conversation. Do not reveal private memory. If no greeting is appropriate, stay silent.",
      ].join("\n"),
    );

    clock.setTime(8_000);
    await monitor.advancePoll();
    clock.setTime(9_000);
    await monitor.advancePoll();
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("routes a transition only to the participant's newest eligible thread", async () => {
    const clock = createGatewaySchedulerClock(1);
    const getPresence = vi
      .fn()
      .mockResolvedValueOnce({ presence: "away" })
      .mockResolvedValueOnce({ presence: "away" })
      .mockResolvedValueOnce({ presence: "active" })
      .mockResolvedValueOnce({ presence: "away" });
    const enqueue = vi.fn(completedReceipt);
    const monitor = createPresenceFixture(
      {
        accountId: "default",
        accountConfig: { mode: "auto" },
        client: { getPresence } as never,
        cooldownStore: createCooldownStore(),
        enqueue,
        captureTarget,
      },
      clock,
    );
    monitor.observe(
      createPrepared({
        userId: "U123",
        channelId: "COLD",
        channelType: "channel",
        threadId: "1.000",
        sessionKey: "session:old",
      }),
    );
    clock.setTime(2);
    monitor.observe(
      createPrepared({
        userId: "U123",
        channelId: "CNEW",
        channelType: "channel",
        threadId: "2.000",
        sessionKey: "session:new",
      }),
    );
    clock.setTime(3);
    monitor.observe(
      createPrepared({
        userId: "UOTHER",
        channelId: "COLD",
        channelType: "channel",
        threadId: "1.000",
        sessionKey: "session:old",
      }),
    );

    await monitor.advancePoll();
    await monitor.advancePoll();

    expect(enqueue).toHaveBeenCalledWith(
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
    const teamOnePresence = vi
      .fn()
      .mockResolvedValueOnce({ presence: "away" })
      .mockResolvedValueOnce({ presence: "active" });
    const teamTwoPresence = vi
      .fn()
      .mockResolvedValueOnce({ presence: "away" })
      .mockResolvedValueOnce({ presence: "active" });
    const resolveClient = vi.fn((teamId?: string) => {
      if (teamId === "T11111111") {
        return { getPresence: teamOnePresence } as never;
      }
      if (teamId === "T22222222") {
        return { getPresence: teamTwoPresence } as never;
      }
      throw new Error(`unexpected team ${teamId}`);
    });
    const enqueue = vi.fn(completedReceipt);
    const monitor = createPresenceFixture({
      accountId: "org",
      accountConfig: { mode: "auto" },
      resolveClient,
      cooldownStore: createCooldownStore(),
      enqueue,
      captureTarget,
    });
    monitor.observe(createPrepared({ userId: "U12345678", teamId: "T11111111" }));
    monitor.observe(createPrepared({ userId: "U12345678", teamId: "T22222222" }));

    await monitor.advancePoll();
    await monitor.advancePoll();

    expect(resolveClient).toHaveBeenCalledWith("T11111111");
    expect(resolveClient).toHaveBeenCalledWith("T22222222");
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenCalledWith(
      expect.stringContaining('team_id="T11111111"'),
      expect.objectContaining({
        agentId: "main",
        deliveryContext: expect.objectContaining({
          to: "team:T11111111:user:U12345678",
        }),
      }),
    );
    expect(enqueue).toHaveBeenCalledWith(
      expect.stringContaining('team_id="T22222222"'),
      expect.objectContaining({
        agentId: "main",
        deliveryContext: expect.objectContaining({
          to: "team:T22222222:user:U12345678",
        }),
      }),
    );
  });

  it("does not let excluded auto channels evict an eligible direct message", async () => {
    const getPresence = vi.fn().mockResolvedValue({ presence: "away" });
    const monitor = createPresenceFixture({
      accountId: "default",
      accountConfig: { mode: "auto" },
      client: { getPresence } as never,
      cooldownStore: createCooldownStore(),
      enqueue: vi.fn(completedReceipt),
      captureTarget,
    });
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

  it("times out a stalled presence request and polls the next user", async () => {
    vi.useFakeTimers();
    let resolveStalled!: (value: { presence: string }) => void;
    const stalled = new Promise<{ presence: string }>((resolve) => {
      resolveStalled = resolve;
    });
    let polling: Promise<void> | undefined;
    try {
      const getPresence = vi
        .fn()
        .mockReturnValueOnce(stalled)
        .mockResolvedValueOnce({ presence: "away" });
      const monitor = createPresenceFixture({
        accountId: "default",
        accountConfig: { mode: "auto" },
        client: { getPresence } as never,
        cooldownStore: createCooldownStore(),
        enqueue: vi.fn(completedReceipt),
        captureTarget,
      });
      monitor.observe(createPrepared({ userId: "U1", channelId: "D1" }));
      monitor.observe(createPrepared({ userId: "U2", channelId: "D2" }));

      polling = monitor.advancePoll();
      let pollSettled = false;
      void polling.then(() => {
        pollSettled = true;
      });
      await vi.advanceTimersByTimeAsync(SLACK_PRESENCE_REQUEST_TIMEOUT_MS);
      expect(pollSettled).toBe(true);
      await polling;

      expect(getPresence).toHaveBeenNthCalledWith(1, { user: "U1" });
      expect(getPresence).toHaveBeenNthCalledWith(2, { user: "U2" });
    } finally {
      resolveStalled({ presence: "away" });
      await polling;
      vi.useRealTimers();
    }
  });

  it("honors Slack Retry-After without skipping the unpolled page", async () => {
    const clock = createGatewaySchedulerClock(1_000);
    const getPresence = vi
      .fn()
      .mockRejectedValueOnce(new WebAPIRateLimitedError(120))
      .mockResolvedValue({ presence: "away" });
    const monitor = createPresenceFixture(
      {
        accountId: "default",
        accountConfig: { mode: "on" },
        client: { getPresence } as never,
        cooldownStore: createCooldownStore(),
        enqueue: vi.fn(completedReceipt),
        captureTarget,
      },
      clock,
    );
    for (let index = 1; index <= 46; index += 1) {
      monitor.observe(createPrepared({ userId: `U${String(index).padStart(4, "0")}` }));
    }

    await monitor.advancePoll();
    expect(getPresence).toHaveBeenCalledExactlyOnceWith({ user: "U0001" });

    clock.setTime(120_999);
    await monitor.advancePoll();
    expect(getPresence).toHaveBeenCalledTimes(1);

    clock.setTime(121_000);
    await monitor.advancePoll();
    expect(getPresence).toHaveBeenNthCalledWith(2, { user: "U0001" });
    expect(getPresence).toHaveBeenNthCalledWith(3, { user: "U0002" });
    expect(getPresence).toHaveBeenCalledTimes(46);

    await monitor.advancePoll();
    expect(getPresence).toHaveBeenNthCalledWith(47, { user: "U0046" });
  });

  it("bounds stop while a presence request is stalled", async () => {
    vi.useFakeTimers();
    let resolveStalled!: (value: { presence: string }) => void;
    const stalled = new Promise<{ presence: string }>((resolve) => {
      resolveStalled = resolve;
    });
    let polling: Promise<void> | undefined;
    try {
      const getPresence = vi.fn(() => stalled);
      const monitor = createPresenceFixture({
        accountId: "default",
        accountConfig: { mode: "auto" },
        client: { getPresence } as never,
        cooldownStore: createCooldownStore(),
        enqueue: vi.fn(completedReceipt),
        captureTarget,
      });
      monitor.observe(createPrepared({ userId: "U1" }));

      polling = monitor.advancePoll();
      const stopping = monitor.stop();
      let stopSettled = false;
      void stopping.then(() => {
        stopSettled = true;
      });
      await vi.advanceTimersByTimeAsync(SLACK_PRESENCE_REQUEST_TIMEOUT_MS);
      expect(stopSettled).toBe(true);
      await Promise.all([polling, stopping]);

      expect(getPresence).toHaveBeenCalledOnce();
    } finally {
      resolveStalled({ presence: "away" });
      await polling;
      vi.useRealTimers();
    }
  });

  it.each(["publish", "stop", "ineligible", "expired", "acceptance-refused", "replaced"] as const)(
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
      const getPresence = vi
        .fn()
        .mockResolvedValueOnce({ presence: "away" })
        .mockResolvedValueOnce({ presence: "active" });
      const enqueue = vi.fn(() => {
        if (outcome === "replaced") {
          throw new Error("session-event admission refused");
        }
        if (outcome === "acceptance-refused") {
          return {
            ...completedReceipt(),
            accepted: Promise.resolve({
              ok: false as const,
              error: "session-event admission refused",
            }),
            settled: Promise.resolve({
              status: "failed" as const,
              executionStarted: false,
              delivered: false,
            }),
          };
        }
        return completedReceipt();
      });
      const clock = createGatewaySchedulerClock(1_000);
      const monitor = createPresenceFixture(
        {
          accountId: "default",
          accountConfig: { mode: "auto" },
          client: { getPresence } as never,
          cooldownStore,
          enqueue,
          captureTarget,
        },
        clock,
      );
      monitor.observe(createPrepared({ userId: "U123" }));
      await monitor.advancePoll();
      const polling = monitor.advancePoll();
      await reservationStarted.promise;
      expect(enqueue).not.toHaveBeenCalled();
      await monitor.advancePoll();
      expect(getPresence).toHaveBeenCalledTimes(2);
      let stopping: Promise<void> | undefined;
      let stopSettled = false;
      if (outcome === "stop") {
        stopping = monitor.stop().then(() => {
          stopSettled = true;
        });
      } else if (outcome === "ineligible") {
        for (let index = 0; index < AUTO_MAX_PARTICIPANTS; index += 1) {
          monitor.observe(createPrepared({ userId: `UOTHER${index}` }));
        }
      } else if (outcome === "expired") {
        clock.setTime(1_000 + 24 * 60 * 60 * 1_000);
      } else if (outcome === "publish") {
        clock.setTime(1_001);
        monitor.observe(
          createPrepared({ userId: "U123", channelId: "DNEW", sessionKey: "session:new" }),
        );
      }
      reservation.resolve(true);
      if (outcome !== "publish") {
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
      }
      await polling;
      await stopping;
      if (outcome === "publish") {
        expect(enqueue).toHaveBeenCalledWith(
          expect.stringContaining('channel_id="DNEW"'),
          expect.objectContaining({ sessionKey: "session:new" }),
        );
      } else {
        expect(stopSettled).toBe(true);
        expect(enqueue).toHaveBeenCalledTimes(
          outcome === "acceptance-refused" || outcome === "replaced" ? 1 : 0,
        );
        expect(await cooldownStore.lookup("default:workspace:U123")).toBe(
          outcome === "replaced" ? 1_001 : undefined,
        );
      }
    },
  );

  it("does not publish when cooldown persistence rejects", async () => {
    const cooldownStore = createCooldownStore();
    cooldownStore.registerIfAbsent = vi.fn().mockRejectedValue(new Error("storage unavailable"));
    const enqueue = vi.fn(completedReceipt);
    const error = vi.fn();
    const monitor = createPresenceFixture({
      accountId: "default",
      accountConfig: { mode: "auto" },
      client: {
        getPresence: vi
          .fn()
          .mockResolvedValueOnce({ presence: "away" })
          .mockResolvedValueOnce({ presence: "active" }),
      } as never,
      cooldownStore,
      enqueue,
      captureTarget,
      error,
    });
    monitor.observe(createPrepared({ userId: "U123" }));
    await monitor.advancePoll();
    await monitor.advancePoll();
    expect(enqueue).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("cooldown persistence failed"));
  });

  it("quiesces an in-flight poll before stop returns", async () => {
    let resolveActive!: (value: { presence: string }) => void;
    const active = new Promise<{ presence: string }>((resolve) => {
      resolveActive = resolve;
    });
    const getPresence = vi
      .fn()
      .mockResolvedValueOnce({ presence: "away" })
      .mockReturnValueOnce(active);
    const enqueue = vi.fn(completedReceipt);
    const monitor = createPresenceFixture({
      accountId: "default",
      accountConfig: { mode: "auto" },
      client: { getPresence } as never,
      cooldownStore: createCooldownStore(),
      enqueue,
      captureTarget,
    });
    monitor.observe(createPrepared({ userId: "U123" }));
    await monitor.advancePoll();

    const polling = monitor.advancePoll();
    const stopping = monitor.stop();
    resolveActive({ presence: "active" });
    await Promise.all([polling, stopping]);

    expect(enqueue).not.toHaveBeenCalled();
  });
});
