import { WebAPIRateLimitedError } from "@slack/web-api";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { describe, expect, it, vi } from "vitest";
import type { PreparedSlackMessage } from "./message-handler/types.js";
import {
  createSlackPresenceMonitor,
  hasSlackPresenceEventsEnabled,
  SLACK_PRESENCE_REQUEST_TIMEOUT_MS,
} from "./presence-monitor.js";

const AUTO_MAX_PARTICIPANTS = 8;

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
    deleteIf: async (key, predicate) => {
      const value = values.get(key);
      return value !== undefined && predicate(value) ? values.delete(key) : false;
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
    let now = 2_000;
    const getPresence = vi
      .fn()
      .mockResolvedValueOnce({ presence: "away" })
      .mockResolvedValueOnce({ presence: "active" });
    const enqueue = vi.fn((..._args: unknown[]) => true);
    const monitor = createSlackPresenceMonitor({
      accountId: "default",
      accountConfig: { mode: "auto", prompt: "Account guidance" },
      client: { getPresence } as never,
      cooldownStore: createCooldownStore(),
      enqueue,
      wake: vi.fn(),
      nowMs: () => now,
    });
    monitor.observe(
      createPrepared({ userId: "U123", mode: "auto", prompt: "Do not send a greeting." }),
    );

    await monitor.pollOnce();
    now = 7_500;
    await monitor.pollOnce();

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
    let now = 2_000;
    const getPresence = vi
      .fn()
      .mockResolvedValueOnce({ presence: "away" })
      .mockResolvedValueOnce({ presence: "active" });
    const enqueue = vi.fn((..._args: unknown[]) => true);
    const monitor = createSlackPresenceMonitor({
      accountId: "default",
      accountConfig: { mode: "auto", prompt: "Account guidance" },
      client: { getPresence } as never,
      cooldownStore: createCooldownStore(),
      enqueue,
      wake: vi.fn(),
      nowMs: () => now,
    });
    monitor.observe(createPrepared({ userId: "U123", mode: "auto", prompt: "" }));

    await monitor.pollOnce();
    now = 7_500;
    await monitor.pollOnce();

    expect(enqueue.mock.calls[0]?.[0]).toBe(
      [
        "Slack presence event:",
        'A human participant became active on Slack after being observed away: user_id="U123" channel_id="D123".',
        "observed_away_at_ms=2000 observed_active_at_ms=7500 observed_away_duration_ms=5500",
      ].join("\n"),
    );
  });

  it("seeds the first sample and wakes only on away-to-active", async () => {
    let now = 1_000;
    const getPresence = vi
      .fn()
      .mockResolvedValueOnce({ presence: "active" })
      .mockResolvedValueOnce({ presence: "away" })
      .mockResolvedValueOnce({ presence: "away" })
      .mockResolvedValueOnce({ presence: "active" })
      .mockResolvedValueOnce({ presence: "away" })
      .mockResolvedValueOnce({ presence: "active" });
    const enqueue = vi.fn((..._args: unknown[]) => true);
    const wake = vi.fn();
    const monitor = createSlackPresenceMonitor({
      accountId: "default",
      accountConfig: { mode: "auto" },
      client: { getPresence } as never,
      cooldownStore: createCooldownStore(),
      enqueue,
      wake,
      nowMs: () => now,
    });
    monitor.observe(createPrepared({ userId: "U123" }));

    await monitor.pollOnce();
    now = 2_000;
    await monitor.pollOnce();
    expect(enqueue).not.toHaveBeenCalled();

    now = 4_000;
    await monitor.pollOnce();
    expect(enqueue).not.toHaveBeenCalled();

    now = 7_500;
    await monitor.pollOnce();
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith(
      expect.stringMatching(
        /observed_away_at_ms=2000 observed_active_at_ms=7500 observed_away_duration_ms=5500/,
      ),
      expect.objectContaining({ agentId: "main", sessionKey: "agent:main:slack:channel:D123" }),
      expect.objectContaining({
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
    expect(wake).toHaveBeenCalledOnce();

    now = 8_000;
    await monitor.pollOnce();
    now = 9_000;
    await monitor.pollOnce();
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("routes a transition only to the participant's newest eligible thread", async () => {
    let now = 1;
    const getPresence = vi
      .fn()
      .mockResolvedValueOnce({ presence: "away" })
      .mockResolvedValueOnce({ presence: "away" })
      .mockResolvedValueOnce({ presence: "active" })
      .mockResolvedValueOnce({ presence: "away" });
    const enqueue = vi.fn(() => true);
    const monitor = createSlackPresenceMonitor({
      accountId: "default",
      accountConfig: { mode: "auto" },
      client: { getPresence } as never,
      cooldownStore: createCooldownStore(),
      enqueue,
      wake: vi.fn(),
      nowMs: () => now,
    });
    monitor.observe(
      createPrepared({
        userId: "U123",
        channelId: "COLD",
        channelType: "channel",
        threadId: "1.000",
        sessionKey: "session:old",
      }),
    );
    now = 2;
    monitor.observe(
      createPrepared({
        userId: "U123",
        channelId: "CNEW",
        channelType: "channel",
        threadId: "2.000",
        sessionKey: "session:new",
      }),
    );
    now = 3;
    monitor.observe(
      createPrepared({
        userId: "UOTHER",
        channelId: "COLD",
        channelType: "channel",
        threadId: "1.000",
        sessionKey: "session:old",
      }),
    );

    await monitor.pollOnce();
    await monitor.pollOnce();

    expect(enqueue).toHaveBeenCalledWith(
      expect.stringContaining('channel_id="CNEW"'),
      expect.objectContaining({ agentId: "main", sessionKey: "session:new" }),
      expect.objectContaining({
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
    const enqueue = vi.fn(() => true);
    const monitor = createSlackPresenceMonitor({
      accountId: "org",
      accountConfig: { mode: "auto" },
      resolveClient,
      cooldownStore: createCooldownStore(),
      enqueue,
      wake: vi.fn(),
    });
    monitor.observe(createPrepared({ userId: "U12345678", teamId: "T11111111" }));
    monitor.observe(createPrepared({ userId: "U12345678", teamId: "T22222222" }));

    await monitor.pollOnce();
    await monitor.pollOnce();

    expect(resolveClient).toHaveBeenCalledWith("T11111111");
    expect(resolveClient).toHaveBeenCalledWith("T22222222");
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenCalledWith(
      expect.stringContaining('team_id="T11111111"'),
      expect.objectContaining({ agentId: "main" }),
      expect.objectContaining({
        deliveryContext: expect.objectContaining({
          to: "team:T11111111:user:U12345678",
        }),
      }),
    );
    expect(enqueue).toHaveBeenCalledWith(
      expect.stringContaining('team_id="T22222222"'),
      expect.objectContaining({ agentId: "main" }),
      expect.objectContaining({
        deliveryContext: expect.objectContaining({
          to: "team:T22222222:user:U12345678",
        }),
      }),
    );
  });

  it("auto excludes top-level channels and threads larger than eight people", async () => {
    const getPresence = vi.fn().mockResolvedValue({ presence: "away" });
    const monitor = createSlackPresenceMonitor({
      accountId: "default",
      accountConfig: { mode: "auto" },
      client: { getPresence } as never,
      cooldownStore: createCooldownStore(),
      enqueue: vi.fn(() => true),
      wake: vi.fn(),
    });
    monitor.observe(createPrepared({ userId: "UTOP", channelId: "C1", channelType: "channel" }));
    for (let index = 0; index <= AUTO_MAX_PARTICIPANTS; index += 1) {
      monitor.observe(
        createPrepared({
          userId: `U${index}`,
          channelId: "C2",
          channelType: "channel",
          threadId: "2.000",
        }),
      );
    }

    await monitor.pollOnce();

    expect(getPresence).not.toHaveBeenCalled();
  });

  it("does not let excluded auto channels evict an eligible direct message", async () => {
    const getPresence = vi.fn().mockResolvedValue({ presence: "away" });
    const monitor = createSlackPresenceMonitor({
      accountId: "default",
      accountConfig: { mode: "auto" },
      client: { getPresence } as never,
      cooldownStore: createCooldownStore(),
      enqueue: vi.fn(() => true),
      wake: vi.fn(),
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

    await monitor.pollOnce();

    expect(getPresence).toHaveBeenCalledExactlyOnceWith({ user: "UDIRECT" });
  });

  it("on includes top-level channels and overrides the auto size cap", async () => {
    const getPresence = vi.fn().mockResolvedValue({ presence: "away" });
    const monitor = createSlackPresenceMonitor({
      accountId: "default",
      accountConfig: { mode: "auto" },
      client: { getPresence } as never,
      cooldownStore: createCooldownStore(),
      enqueue: vi.fn(() => true),
      wake: vi.fn(),
    });
    monitor.observe(
      createPrepared({
        userId: "UTOP",
        channelId: "C1",
        channelType: "channel",
        mode: "on",
      }),
    );
    for (let index = 0; index <= AUTO_MAX_PARTICIPANTS; index += 1) {
      monitor.observe(
        createPrepared({
          userId: `U${index}`,
          channelId: "C2",
          channelType: "channel",
          threadId: "2.000",
          mode: index === AUTO_MAX_PARTICIPANTS ? "on" : "auto",
        }),
      );
    }

    await monitor.pollOnce();

    expect(getPresence).toHaveBeenCalledTimes(AUTO_MAX_PARTICIPANTS + 2);
  });

  it("seeds again after all eligible targets expire", async () => {
    let now = 1;
    const getPresence = vi
      .fn()
      .mockResolvedValueOnce({ presence: "away" })
      .mockResolvedValueOnce({ presence: "active" });
    const enqueue = vi.fn(() => true);
    const monitor = createSlackPresenceMonitor({
      accountId: "default",
      accountConfig: { mode: "auto" },
      client: { getPresence } as never,
      cooldownStore: createCooldownStore(),
      enqueue,
      wake: vi.fn(),
      nowMs: () => now,
    });
    monitor.observe(createPrepared({ userId: "U123" }));
    await monitor.pollOnce();

    now += 24 * 60 * 60 * 1000;
    await monitor.pollOnce();
    monitor.observe(createPrepared({ userId: "U123" }));
    await monitor.pollOnce();

    expect(getPresence).toHaveBeenCalledTimes(2);
    expect(enqueue).not.toHaveBeenCalled();
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
      const monitor = createSlackPresenceMonitor({
        accountId: "default",
        accountConfig: { mode: "auto" },
        client: { getPresence } as never,
        cooldownStore: createCooldownStore(),
        enqueue: vi.fn(() => true),
        wake: vi.fn(),
      });
      monitor.observe(createPrepared({ userId: "U1", channelId: "D1" }));
      monitor.observe(createPrepared({ userId: "U2", channelId: "D2" }));

      polling = monitor.pollOnce();
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
    let now = 1_000;
    const getPresence = vi
      .fn()
      .mockRejectedValueOnce(new WebAPIRateLimitedError(120))
      .mockResolvedValue({ presence: "away" });
    const monitor = createSlackPresenceMonitor({
      accountId: "default",
      accountConfig: { mode: "on" },
      client: { getPresence } as never,
      cooldownStore: createCooldownStore(),
      enqueue: vi.fn(() => true),
      wake: vi.fn(),
      nowMs: () => now,
    });
    for (let index = 1; index <= 46; index += 1) {
      monitor.observe(createPrepared({ userId: `U${String(index).padStart(4, "0")}` }));
    }

    await monitor.pollOnce();
    expect(getPresence).toHaveBeenCalledExactlyOnceWith({ user: "U0001" });

    now += 119_999;
    await monitor.pollOnce();
    expect(getPresence).toHaveBeenCalledTimes(1);

    now += 1;
    await monitor.pollOnce();
    expect(getPresence).toHaveBeenNthCalledWith(2, { user: "U0001" });
    expect(getPresence).toHaveBeenNthCalledWith(3, { user: "U0002" });
    expect(getPresence).toHaveBeenCalledTimes(46);

    await monitor.pollOnce();
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
      const monitor = createSlackPresenceMonitor({
        accountId: "default",
        accountConfig: { mode: "auto" },
        client: { getPresence } as never,
        cooldownStore: createCooldownStore(),
        enqueue: vi.fn(() => true),
        wake: vi.fn(),
      });
      monitor.observe(createPrepared({ userId: "U1" }));

      polling = monitor.pollOnce();
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

  it.each(["publish", "stop", "ineligible", "expired", "queue-refused", "replaced"] as const)(
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
      const deleteIf = cooldownStore.deleteIf.bind(cooldownStore);
      cooldownStore.deleteIf = async (key, predicate) => {
        cleanupStarted.resolve();
        await cleanup.promise;
        return await deleteIf(key, predicate);
      };
      const getPresence = vi
        .fn()
        .mockResolvedValueOnce({ presence: "away" })
        .mockResolvedValueOnce({ presence: "active" });
      const enqueue = vi.fn(() => outcome !== "queue-refused" && outcome !== "replaced");
      const wake = vi.fn();
      let now = 1_000;
      const monitor = createSlackPresenceMonitor({
        accountId: "default",
        accountConfig: { mode: "auto" },
        client: { getPresence } as never,
        cooldownStore,
        enqueue,
        wake,
        nowMs: () => now,
      });
      monitor.observe(createPrepared({ userId: "U123" }));
      await monitor.pollOnce();
      const polling = monitor.pollOnce();
      await reservationStarted.promise;
      expect(enqueue).not.toHaveBeenCalled();
      expect(wake).not.toHaveBeenCalled();
      expect(monitor.pollOnce() === polling).toBe(true);
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
        now += 24 * 60 * 60 * 1_000;
      } else if (outcome === "publish") {
        now += 1;
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
        expect(wake).not.toHaveBeenCalled();
        if (outcome === "replaced") {
          await cooldownStore.register("default:workspace:U123", now + 1);
        }
        cleanup.resolve(true);
      }
      await polling;
      await stopping;
      if (outcome === "publish") {
        expect(enqueue).toHaveBeenCalledWith(
          expect.stringContaining('channel_id="DNEW"'),
          expect.objectContaining({ sessionKey: "session:new" }),
          expect.anything(),
        );
        expect(wake).toHaveBeenCalledOnce();
      } else {
        expect(stopSettled).toBe(true);
        expect(enqueue).toHaveBeenCalledTimes(
          outcome === "queue-refused" || outcome === "replaced" ? 1 : 0,
        );
        expect(await cooldownStore.lookup("default:workspace:U123")).toBe(
          outcome === "replaced" ? now + 1 : undefined,
        );
        expect(wake).not.toHaveBeenCalled();
      }
    },
  );

  it("keeps the cooldown until expiry when an older store lacks conditional deletion", async () => {
    const cooldownStore: PluginStateKeyedStore<number> = createCooldownStore();
    delete cooldownStore.deleteIf;
    const monitor = createSlackPresenceMonitor({
      accountId: "default",
      accountConfig: { mode: "auto" },
      client: {
        getPresence: vi
          .fn()
          .mockResolvedValueOnce({ presence: "away" })
          .mockResolvedValueOnce({ presence: "active" }),
      } as never,
      cooldownStore,
      enqueue: () => false,
      wake: vi.fn(),
      nowMs: () => 1_000,
    });
    monitor.observe(createPrepared({ userId: "U123" }));
    await monitor.pollOnce();
    await monitor.pollOnce();
    await monitor.stop();
    expect(await cooldownStore.lookup("default:workspace:U123")).toBe(1_000);
  });

  it("does not publish when cooldown persistence rejects", async () => {
    const cooldownStore = createCooldownStore();
    cooldownStore.registerIfAbsent = vi.fn().mockRejectedValue(new Error("storage unavailable"));
    const enqueue = vi.fn(() => true);
    const wake = vi.fn();
    const error = vi.fn();
    const monitor = createSlackPresenceMonitor({
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
      wake,
      error,
    });
    monitor.observe(createPrepared({ userId: "U123" }));
    await monitor.pollOnce();
    await monitor.pollOnce();
    expect(enqueue).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
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
    const enqueue = vi.fn(() => true);
    const monitor = createSlackPresenceMonitor({
      accountId: "default",
      accountConfig: { mode: "auto" },
      client: { getPresence } as never,
      cooldownStore: createCooldownStore(),
      enqueue,
      wake: vi.fn(),
    });
    monitor.observe(createPrepared({ userId: "U123" }));
    await monitor.pollOnce();

    const polling = monitor.pollOnce();
    const stopping = monitor.stop();
    resolveActive({ presence: "active" });
    await Promise.all([polling, stopping]);

    expect(enqueue).not.toHaveBeenCalled();
  });
});
