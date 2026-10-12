// Discord tests cover stale ambient backlog disposition at the real ingress boundary.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ChannelType, GatewayDispatchEvents, type APIMessage } from "discord-api-types/v10";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import type { ChannelIngressQueue } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../internal/discord.js";
import type { DiscordGatewayChannelInfo } from "../internal/gateway-channel-inventory.js";
import { GatewayPlugin } from "../internal/gateway.js";
import type { DiscordGuildEntryResolved } from "./allow-list.js";
import { clearGateways, registerGateway } from "./gateway-registry.js";
import { createDiscordIngressMonitor } from "./ingress.js";
import type { DiscordLivePolicy } from "./live-policy.js";

type DiscordIngressPayload = {
  version: 1;
  receivedAt: number;
  rawMessage: APIMessage;
};

type DiscordQueue = ChannelIngressQueue<DiscordIngressPayload>;

/** The policy's 15-minute cutoff, pinned here rather than exported for tests only. */
const DISCORD_STALE_AMBIENT_BACKLOG_MS = 15 * 60 * 1_000;
const BOT_ID = "bot-1";
const NOW = Date.now();
const STALE_AT = NOW - DISCORD_STALE_AMBIENT_BACKLOG_MS - 60_000;

/** Live gateway inventory: a mention-gated channel, a direct-open one, a thread. */
const CHANNELS: Record<string, DiscordGatewayChannelInfo> = {
  "chan-gated": { guildId: "g1", name: "general", type: ChannelType.GuildText },
  "chan-open": { guildId: "g1", name: "concierge", type: ChannelType.GuildText },
  "chan-gated-2": { guildId: "g1", name: "random", type: ChannelType.GuildText },
  "thread-1": {
    guildId: "g1",
    name: "triage",
    parentId: "chan-gated",
    type: ChannelType.PublicThread,
  },
};

function rawMessage(params: {
  id: string;
  channelId: string;
  content?: string;
  sentAt: number;
  mentions?: Array<{ id: string }>;
  embeds?: unknown[];
}): APIMessage {
  return {
    id: params.id,
    channel_id: params.channelId,
    guild_id: "g1",
    content: params.content ?? "just chatting",
    author: {
      id: "user-1",
      username: "alice",
      discriminator: "0",
      avatar: null,
    },
    attachments: [],
    embeds: params.embeds ?? [],
    mentions: params.mentions ?? [],
    mention_roles: [],
    mention_everyone: false,
    timestamp: new Date(params.sentAt).toISOString(),
    edited_timestamp: null,
    components: [],
    pinned: false,
    type: 0,
    tts: false,
    // SAFETY: the durable payload stores the raw gateway frame; this fixture
    // supplies exactly the MESSAGE_CREATE fields ingress and policy read.
  } as unknown as APIMessage;
}

async function seed(queue: DiscordQueue, params: Parameters<typeof rawMessage>[0]): Promise<void> {
  await queue.enqueue(
    params.id,
    { version: 1, receivedAt: params.sentAt, rawMessage: rawMessage(params) },
    { laneKey: `channel:${params.channelId}`, receivedAt: params.sentAt },
  );
}

function livePolicy(
  guildEntries?: Record<string, DiscordGuildEntryResolved>,
  cfg: OpenClawConfig = {} as OpenClawConfig,
  discordConfig: Record<string, unknown> = {},
): DiscordLivePolicy {
  return {
    isCurrent: () => true,
    isConfigCurrent: () => true,
    accountId: "default",
    cfg,
    discordConfig,
    guildEntries,
    allowFrom: [],
    dmPolicy: "open",
    groupPolicy: "open",
    dmEnabled: true,
    groupDmEnabled: true,
    groupDmChannels: [],
    allowNameMatching: false,
    // SAFETY: the stale policy reads only the published policy fields set above.
  } as unknown as DiscordLivePolicy;
}

async function withQueue(run: (queue: DiscordQueue) => Promise<void>): Promise<void> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-discord-stale-"));
  const stateDir = await fs.realpath(created);
  const queue = createChannelIngressQueueForTests<DiscordIngressPayload>({
    channelId: "discord",
    accountId: "default",
    stateDir,
  });
  try {
    await run(queue);
  } finally {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

function createRegisteredGateway() {
  const gateway = new GatewayPlugin({});
  // SAFETY: the inventory is rebuilt from dispatches, so the fixture injects a
  // listener-free client instead of opening a gateway socket.
  (gateway as unknown as { client: unknown }).client = {
    dispatchGatewayEvent: vi.fn(async () => {}),
    getPlugin: vi.fn(() => undefined),
  };
  const handleDispatch = (t: string, d: unknown): Promise<void> =>
    (
      gateway as unknown as {
        handleDispatch(payload: { t: string; d: unknown }): Promise<void>;
      }
    ).handleDispatch({ t, d });
  return { gateway, handleDispatch };
}

describe("Discord ingress stale ambient backlog boundary", () => {
  afterEach(() => {
    clearGateways();
  });

  it("drops only provably ambient stale guild backlog and dispatches the rest", async () => {
    await withQueue(async (queue) => {
      // One mention-gated lane holding stale ambient, stale addressed, and current
      // work, plus a direct-open channel and a thread on their own lanes.
      await seed(queue, { id: "stale-ambient", channelId: "chan-gated", sentAt: STALE_AT });
      await seed(queue, {
        id: "stale-addressed",
        channelId: "chan-gated",
        sentAt: STALE_AT + 1,
        mentions: [{ id: BOT_ID }],
      });
      await seed(queue, { id: "current-ambient", channelId: "chan-gated", sentAt: NOW });
      await seed(queue, { id: "stale-open", channelId: "chan-open", sentAt: STALE_AT });
      await seed(queue, { id: "stale-thread", channelId: "thread-1", sentAt: STALE_AT });

      const dispatched: string[] = [];
      const monitor = createDiscordIngressMonitor({
        accountId: "default",
        // SAFETY: gateway mapping only reads the raw frame for these fixtures.
        client: {} as Client,
        runtime: { error: vi.fn(), log: vi.fn() },
        botUserId: BOT_ID,
        readPolicy: async () =>
          livePolicy({ g1: { channels: { "chan-open": { requireMention: false } } } }),
        resolveChannelInfo: (channelId) => CHANNELS[channelId],
        isChannelInventoryHydrating: () => false,
        queue,
        dispatch: async (event, lifecycle) => {
          dispatched.push(String(event.id));
          await lifecycle.onAdopted();
        },
      });

      monitor.start();
      try {
        await vi.waitFor(
          async () => {
            expect(await queue.listPending({ limit: "all" })).toEqual([]);
            expect(await queue.listClaims()).toEqual([]);
          },
          { timeout: 15_000, interval: 50 },
        );
      } finally {
        await monitor.stop();
      }

      expect(dispatched).not.toContain("stale-ambient");
      expect(dispatched.toSorted()).toEqual([
        "current-ambient",
        "stale-addressed",
        "stale-open",
        "stale-thread",
      ]);
      expect(await queue.listFailed?.({ limit: "all" })).toMatchObject([
        { id: "stale-ambient", reason: "stale-ambient-backlog" },
      ]);
    });
  });

  it("preserves a stale mention request for an agent configured only under agents.entries", async () => {
    await withQueue(async (queue) => {
      // Same mention-gated lane and age; only the text differs. The agent has no
      // agents.list entry, so a list-only roster would miss its mention pattern.
      await seed(queue, { id: "stale-ambient", channelId: "chan-gated", sentAt: STALE_AT });
      await seed(queue, {
        id: "stale-entries-request",
        channelId: "chan-gated",
        sentAt: STALE_AT + 1,
        content: "helper, can you look at this when you are back?",
      });

      const dispatched: string[] = [];
      const monitor = createDiscordIngressMonitor({
        accountId: "default",
        // SAFETY: gateway mapping only reads the raw frame for these fixtures.
        client: {} as Client,
        runtime: { error: vi.fn(), log: vi.fn() },
        botUserId: BOT_ID,
        readPolicy: async () =>
          livePolicy(undefined, {
            agents: { entries: { helper: { groupChat: { mentionPatterns: ["\\bhelper\\b"] } } } },
          } as unknown as OpenClawConfig),
        resolveChannelInfo: (channelId) => CHANNELS[channelId],
        isChannelInventoryHydrating: () => false,
        queue,
        dispatch: async (event, lifecycle) => {
          dispatched.push(String(event.id));
          await lifecycle.onAdopted();
        },
      });

      monitor.start();
      try {
        await vi.waitFor(
          async () => {
            expect(await queue.listPending({ limit: "all" })).toEqual([]);
            expect(await queue.listClaims()).toEqual([]);
          },
          { timeout: 15_000, interval: 50 },
        );
      } finally {
        await monitor.stop();
      }

      expect(dispatched).toEqual(["stale-entries-request"]);
      expect(await queue.listFailed?.({ limit: "all" })).toMatchObject([
        { id: "stale-ambient", reason: "stale-ambient-backlog" },
      ]);
    });
  });

  it("preserves a stale broadcast-participant mention the provider policy filters out", async () => {
    await withQueue(async (queue) => {
      // Mention-gated lane, provider mentionPatterns.denyIn for this channel, and
      // a broadcast entry naming an entries-only agent: "@helper" is still a
      // request for preflight's participant matcher, so it must not expire.
      await seed(queue, { id: "stale-ambient", channelId: "chan-gated", sentAt: STALE_AT });
      await seed(queue, {
        id: "stale-broadcast-request",
        channelId: "chan-gated",
        sentAt: STALE_AT + 1,
        content: "@helper can you look at this when you are back?",
      });

      const dispatched: string[] = [];
      const monitor = createDiscordIngressMonitor({
        accountId: "default",
        // SAFETY: gateway mapping only reads the raw frame for these fixtures.
        client: {} as Client,
        runtime: { error: vi.fn(), log: vi.fn() },
        botUserId: BOT_ID,
        readPolicy: async () =>
          livePolicy(
            undefined,
            {
              agents: { entries: { helper: { groupChat: { mentionPatterns: ["\\bhelper\\b"] } } } },
              broadcast: { "discord:chan-gated": ["helper"] },
            } as unknown as OpenClawConfig,
            { mentionPatterns: { denyIn: ["chan-gated"] } },
          ),
        resolveChannelInfo: (channelId) => CHANNELS[channelId],
        isChannelInventoryHydrating: () => false,
        queue,
        dispatch: async (event, lifecycle) => {
          dispatched.push(String(event.id));
          await lifecycle.onAdopted();
        },
      });

      monitor.start();
      try {
        await vi.waitFor(
          async () => {
            expect(await queue.listPending({ limit: "all" })).toEqual([]);
            expect(await queue.listClaims()).toEqual([]);
          },
          { timeout: 15_000, interval: 50 },
        );
      } finally {
        await monitor.stop();
      }

      expect(dispatched).toEqual(["stale-broadcast-request"]);
      expect(await queue.listFailed?.({ limit: "all" })).toMatchObject([
        { id: "stale-ambient", reason: "stale-ambient-backlog" },
      ]);
    });
  });

  it("leaves a row the policy cannot project to claim-time handling and keeps draining", async () => {
    await withQueue(async (queue) => {
      // ClawSweeper rev 18: passes the container checks, but text projection
      // throws on the null embed. It must not reject the pre-claim pass.
      await seed(queue, {
        id: "stale-unreadable",
        channelId: "chan-gated",
        sentAt: STALE_AT,
        content: "",
        embeds: [null],
      });
      await seed(queue, { id: "stale-ambient", channelId: "chan-gated-2", sentAt: STALE_AT + 1 });
      await seed(queue, {
        id: "stale-addressed",
        channelId: "chan-open",
        sentAt: STALE_AT + 2,
        mentions: [{ id: BOT_ID }],
      });

      const dispatched: string[] = [];
      const monitor = createDiscordIngressMonitor({
        accountId: "default",
        // SAFETY: gateway mapping only reads the raw frame for these fixtures.
        client: {} as Client,
        runtime: { error: vi.fn(), log: vi.fn() },
        botUserId: BOT_ID,
        readPolicy: async () => livePolicy(),
        resolveChannelInfo: (channelId) => CHANNELS[channelId],
        isChannelInventoryHydrating: () => false,
        queue,
        dispatch: async (event, lifecycle) => {
          dispatched.push(String(event.id));
          await lifecycle.onAdopted();
        },
      });

      monitor.start();
      try {
        await vi.waitFor(
          async () => {
            expect(await queue.listPending({ limit: "all" })).toEqual([]);
            expect(await queue.listClaims()).toEqual([]);
          },
          { timeout: 15_000, interval: 50 },
        );
      } finally {
        await monitor.stop();
      }

      // The unreadable row reached the canonical claim path; it was neither
      // expired nor dropped, and the other lanes were decided as usual.
      expect(dispatched.toSorted()).toEqual(["stale-addressed", "stale-unreadable"]);
      expect(await queue.listFailed?.({ limit: "all" })).toMatchObject([
        { id: "stale-ambient", reason: "stale-ambient-backlog" },
      ]);
    });
  });

  it("never dispatches stale ambient backlog admitted before the inventory hydrates", async () => {
    await withQueue(async (queue) => {
      await seed(queue, { id: "stale-ambient", channelId: "chan-gated", sentAt: STALE_AT });
      // A different lane, so this proves unrelated work is not held by the defer.
      await seed(queue, {
        id: "stale-addressed",
        channelId: "chan-open",
        sentAt: STALE_AT + 1,
        mentions: [{ id: BOT_ID }],
      });

      const dispatched: string[] = [];
      // The session has announced g1 but has not delivered its channels yet.
      let hydrating = true;
      const monitor = createDiscordIngressMonitor({
        accountId: "default",
        // SAFETY: gateway mapping only reads the raw frame for these fixtures.
        client: {} as Client,
        runtime: { error: vi.fn(), log: vi.fn() },
        botUserId: BOT_ID,
        readPolicy: async () => livePolicy(),
        resolveChannelInfo: (channelId) => (hydrating ? undefined : CHANNELS[channelId]),
        isChannelInventoryHydrating: () => hydrating,
        queue,
        dispatch: async (event, lifecycle) => {
          dispatched.push(String(event.id));
          await lifecycle.onAdopted();
        },
      });

      monitor.start();
      try {
        // Addressed work on another lane still flows while the guild hydrates;
        // the ambient row is held rather than classified against a half-built
        // session. Later work on its own lane stays behind it, as FIFO requires.
        await vi.waitFor(() => expect(dispatched).toEqual(["stale-addressed"]), {
          timeout: 15_000,
          interval: 50,
        });
        expect((await queue.listPending({ limit: "all" })).map((row) => row.id)).toEqual([
          "stale-ambient",
        ]);
        expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);

        hydrating = false;
        await vi.waitFor(
          async () => {
            expect(await queue.listPending({ limit: "all" })).toEqual([]);
            expect(await queue.listClaims()).toEqual([]);
          },
          { timeout: 15_000, interval: 50 },
        );
      } finally {
        await monitor.stop();
      }

      expect(dispatched).toEqual(["stale-addressed"]);
      expect(await queue.listFailed?.({ limit: "all" })).toMatchObject([
        { id: "stale-ambient", reason: "stale-ambient-backlog" },
      ]);
    });
  });

  it("holds stale guild backlog through the pre-registry startup window", async () => {
    await withQueue(async (queue) => {
      await seed(queue, { id: "stale-ambient", channelId: "chan-gated", sentAt: STALE_AT });
      await seed(queue, {
        id: "stale-addressed",
        channelId: "chan-open",
        sentAt: STALE_AT + 1,
        mentions: [{ id: BOT_ID }],
      });

      const dispatched: string[] = [];
      // The real default resolver, exercised exactly as the provider wires it:
      // the handler starts its drain before runDiscordGatewayLifecycle registers
      // the account's gateway.
      const monitor = createDiscordIngressMonitor({
        accountId: "default",
        // SAFETY: gateway mapping only reads the raw frame for these fixtures.
        client: {} as Client,
        runtime: { error: vi.fn(), log: vi.fn() },
        botUserId: BOT_ID,
        readPolicy: async () => livePolicy(),
        queue,
        dispatch: async (event, lifecycle) => {
          dispatched.push(String(event.id));
          await lifecycle.onAdopted();
        },
      });

      monitor.start();
      try {
        await vi.waitFor(() => expect(dispatched).toEqual(["stale-addressed"]), {
          timeout: 15_000,
          interval: 50,
        });
        // No gateway is registered yet, so the ambient row must not be claimed.
        expect((await queue.listPending({ limit: "all" })).map((row) => row.id)).toEqual([
          "stale-ambient",
        ]);
        expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);

        const { gateway, handleDispatch } = createRegisteredGateway();
        registerGateway("default", gateway);
        // Registered but not READY: still cannot answer for the guild.
        await vi.waitFor(() => expect(dispatched).toEqual(["stale-addressed"]), {
          timeout: 1_000,
          interval: 50,
        });
        expect((await queue.listPending({ limit: "all" })).map((row) => row.id)).toEqual([
          "stale-ambient",
        ]);

        await handleDispatch(GatewayDispatchEvents.Ready, {
          session_id: "s1",
          guilds: [{ id: "g1", unavailable: true }],
        });
        await handleDispatch(GatewayDispatchEvents.GuildCreate, {
          id: "g1",
          voice_states: [],
          channels: [{ id: "chan-gated", name: "general", type: ChannelType.GuildText }],
          threads: [],
        });

        await vi.waitFor(
          async () => {
            expect(await queue.listPending({ limit: "all" })).toEqual([]);
            expect(await queue.listClaims()).toEqual([]);
          },
          { timeout: 15_000, interval: 50 },
        );
      } finally {
        await monitor.stop();
      }

      expect(dispatched).toEqual(["stale-addressed"]);
      expect(await queue.listFailed?.({ limit: "all" })).toMatchObject([
        { id: "stale-ambient", reason: "stale-ambient-backlog" },
      ]);
    });
  });

  it.each([
    ["the gated channel is renamed into a direct-open name", "chan-gated", "concierge"],
    ["an unrelated channel is renamed (control)", "chan-other", "concierge"],
  ])(
    "re-checks the channel facts at the fail commit when %s",
    async (_case, renamedId, renamedTo) => {
      await withQueue(async (queue) => {
        await seed(queue, { id: "stale-ambient", channelId: "chan-gated", sentAt: STALE_AT });
        const { gateway, handleDispatch } = createRegisteredGateway();
        registerGateway("default", gateway);
        await handleDispatch(GatewayDispatchEvents.Ready, {
          session_id: "s1",
          guilds: [{ id: "g1", unavailable: true }],
        });
        await handleDispatch(GatewayDispatchEvents.GuildCreate, {
          id: "g1",
          voice_states: [],
          channels: [
            { id: "chan-gated", name: "general", type: ChannelType.GuildText },
            { id: "chan-other", name: "random", type: ChannelType.GuildText },
          ],
          threads: [],
        });
        // ClawSweeper rev 22: a CHANNEL_UPDATE lands after the verdict and
        // before the SQLite fail commits.
        const fail = queue.fail.bind(queue);
        let renamed = false;
        queue.fail = vi.fn(async (...args: Parameters<typeof queue.fail>) => {
          if (!renamed) {
            renamed = true;
            await handleDispatch(GatewayDispatchEvents.ChannelUpdate, {
              id: renamedId,
              guild_id: "g1",
              name: renamedTo,
              type: ChannelType.GuildText,
            });
          }
          return await fail(...args);
        });

        const dispatched: string[] = [];
        const monitor = createDiscordIngressMonitor({
          accountId: "default",
          // SAFETY: gateway mapping only reads the raw frame for these fixtures.
          client: {} as Client,
          runtime: { error: vi.fn(), log: vi.fn() },
          botUserId: BOT_ID,
          readPolicy: async () =>
            livePolicy({ g1: { channels: { concierge: { requireMention: false } } } }),
          queue,
          dispatch: async (event, lifecycle) => {
            dispatched.push(String(event.id));
            await lifecycle.onAdopted();
          },
        });

        monitor.start();
        try {
          await vi.waitFor(
            async () => {
              expect(await queue.listPending({ limit: "all" })).toEqual([]);
              expect(await queue.listClaims()).toEqual([]);
            },
            { timeout: 15_000, interval: 50 },
          );
        } finally {
          await monitor.stop();
        }

        if (renamedId === "chan-gated") {
          // The old verdict rolled back; the next pass read the new name and
          // left the row to the direct-open channel's normal dispatch.
          expect(dispatched).toEqual(["stale-ambient"]);
          expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
        } else {
          expect(dispatched).toEqual([]);
          expect(await queue.listFailed?.({ limit: "all" })).toMatchObject([
            { id: "stale-ambient", reason: "stale-ambient-backlog" },
          ]);
        }
      });
    },
  );
});
