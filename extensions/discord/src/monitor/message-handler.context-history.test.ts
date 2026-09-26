import path from "node:path";
import { ChannelType, MessageType, type APIMessage } from "discord-api-types/v10";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Message } from "../internal/discord.js";
import { setDiscordRuntime } from "../runtime.js";
import { buildDiscordMessageProcessContext } from "./message-handler.context.js";
import type { DiscordHistoryEntry } from "./message-handler.history.js";
import { preflightDiscordMessage } from "./message-handler.preflight.js";
import {
  createDiscordPreflightArgs,
  createGuildEvent,
  createGuildTextClient,
} from "./message-handler.preflight.test-helpers.js";
import type { DiscordMessagePreflightContext } from "./message-handler.preflight.types.js";
import { createBaseDiscordMessageContext } from "./message-handler.test-harness.js";

const startedAt = Date.parse("2026-01-01T00:00:00.000Z");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function nativeMessage(
  id: number,
  content = `discussion-${id}`,
  overrides: Partial<APIMessage> = {},
): APIMessage {
  return {
    id: String(id),
    channel_id: "c1",
    author: {
      id: "111",
      username: "alice",
      discriminator: "0",
      global_name: "Alice",
      avatar: null,
    },
    content,
    timestamp: new Date(startedAt + id * 10).toISOString(),
    edited_timestamp: null,
    type: 0,
    tts: false,
    pinned: false,
    mentions: [],
    mention_roles: [],
    mention_everyone: false,
    attachments: [],
    embeds: [],
    ...overrides,
  };
}

function cachedEntry(id: string, body: string): DiscordHistoryEntry {
  return {
    messageId: id,
    sender: "Alice",
    body,
    senderProvenance: { id: "111", memberRoleIds: [] },
  };
}

async function recentContext(overrides: Record<string, unknown> = {}) {
  return await createBaseDiscordMessageContext(
    {
      historyLimit: 20,
      message: {
        id: "1000",
        channelId: "c1",
        timestamp: new Date(startedAt + 10_000).toISOString(),
        attachments: [],
      },
      client: { rest: { get: vi.fn().mockResolvedValue([]) } },
      ...overrides,
    },
    { storePath: path.join(tempDirs.make("discord-native-history-"), "sessions.json") },
  );
}

const buildContext = (ctx: DiscordMessagePreflightContext) =>
  buildDiscordMessageProcessContext({ ctx, text: "addressed current turn", mediaList: [] });

describe("Discord native recent history through process context", () => {
  beforeEach(() => {
    setDiscordRuntime(createPluginRuntimeMock());
  });

  it("keeps quiet ingress quiet, then excludes each debounced original without losing its current text", async () => {
    const base = await recentContext();
    const get = vi
      .fn()
      .mockResolvedValue([
        nativeMessage(999, "interleaved discussion"),
        nativeMessage(998, "first batch original"),
        nativeMessage(997, "quiet earlier discussion"),
      ]);
    const client = createGuildTextClient("c1");
    Object.assign(client, { rest: { get } });
    const quiet = new Message(client, nativeMessage(997, "quiet earlier discussion"));
    const first = new Message(client, nativeMessage(998, "first batch original"));
    const current = new Message(
      client,
      nativeMessage(1000, "<@777> addressed current turn", {
        mentions: [{ ...nativeMessage(1000).author, id: "777", username: "openclaw" }],
      }),
    );
    const guildEntries = { g1: { channels: { c1: { enabled: true, requireMention: true } } } };
    const preflight = {
      ...createDiscordPreflightArgs({
        cfg: base.cfg,
        discordConfig: {},
        client,
        botUserId: "777",
        data: createGuildEvent({
          channelId: "c1",
          guildId: "g1",
          author: quiet.author,
          message: quiet,
        }),
      }),
      runtime: base.runtime,
      historyLimit: 2,
      guildEntries,
    };

    expect(await preflightDiscordMessage(preflight)).toBeNull();
    expect(get).not.toHaveBeenCalled();
    const accepted = await preflightDiscordMessage({
      ...preflight,
      precedingMessages: [first],
      data: createGuildEvent({
        channelId: "c1",
        guildId: "g1",
        author: current.author,
        message: current,
      }),
    });
    expect(accepted).not.toBeNull();
    const result = await buildDiscordMessageProcessContext({
      ctx: accepted!,
      text: accepted!.messageText,
      mediaList: accepted!.preparedMedia,
    });

    expect(result?.ctxPayload.BodyForAgent).toContain("first batch original");
    expect(result?.ctxPayload.BodyForAgent).toContain("addressed current turn");
    expect(result?.ctxPayload.Body?.match(/first batch original/gu)).toHaveLength(1);
    expect(result?.ctxPayload.InboundHistory?.map((entry) => entry.messageId)).toEqual([
      "997",
      "999",
    ]);
    expect(get).toHaveBeenCalledWith("/channels/c1/messages", { before: "1000", limit: 3 });
  });

  it("recovers the same bounded discussion after replacing the monitor-local map", async () => {
    const native = Array.from({ length: 55 }, (_, index) => nativeMessage(900 - index));
    const get = vi.fn(async (_path: string, query: { limit: number; before: string }) =>
      native.filter((message) => BigInt(message.id) < BigInt(query.before)).slice(0, query.limit),
    );
    const warm = await recentContext({
      client: { rest: { get } },
      guildHistories: new Map([["c1", [cachedEntry("899", "obsolete ingress text")]]]),
    });
    const first = await buildContext(warm);
    const replacement = await recentContext({ cfg: warm.cfg, client: { rest: { get } } });
    const restarted = await buildContext(replacement);
    const expectedIds = Array.from({ length: 20 }, (_, index) => String(881 + index));

    expect(first?.ctxPayload.InboundHistory?.map((entry) => entry.messageId)).toEqual(expectedIds);
    expect(restarted?.ctxPayload.InboundHistory).toEqual(first?.ctxPayload.InboundHistory);
    expect(restarted?.ctxPayload.Body).toContain("discussion-881");
    expect(restarted?.ctxPayload.Body).toContain("discussion-900");
    expect(restarted?.ctxPayload.Body).not.toContain("discussion-880");
    expect(restarted?.ctxPayload.Body).not.toContain("obsolete ingress text");
    expect(get.mock.calls).toEqual([
      ["/channels/c1/messages", { before: "1000", limit: 20 }],
      ["/channels/c1/messages", { before: "1000", limit: 20 }],
    ]);
  });

  it("paginates only the configured physical window, with identical Body and InboundHistory selection", async () => {
    const native = Array.from({ length: 150 }, (_, index) => nativeMessage(900 - index));
    const get = vi.fn(async (_path: string, query: { limit: number; before: string }) =>
      native.filter((message) => BigInt(message.id) < BigInt(query.before)).slice(0, query.limit),
    );
    const result = await buildContext(
      await recentContext({ historyLimit: 105, client: { rest: { get } } }),
    );
    const selected = Array.from({ length: 105 }, (_, index) => String(796 + index));

    expect(result?.ctxPayload.InboundHistory?.map((entry) => entry.messageId)).toEqual(selected);
    expect(
      result?.ctxPayload.Body?.match(/\[id:(\d+) channel:c1\]/gu)?.map(
        (label) => label.match(/\d+/u)?.[0],
      ),
    ).toEqual(selected);
    expect(get.mock.calls).toEqual([
      ["/channels/c1/messages", { before: "1000", limit: 100 }],
      ["/channels/c1/messages", { before: "801", limit: 5 }],
    ]);
  });

  it.each(["all", "allowlist", "allowlist_quote"] as const)(
    "applies %s visibility to native sender identities without extending the physical window",
    async (mode) => {
      const get = vi.fn().mockResolvedValue([
        nativeMessage(900, "blocked discussion", {
          author: { ...nativeMessage(900).author, id: "222" },
        }),
        nativeMessage(899, "permitted discussion"),
      ]);
      const ctx = await recentContext({
        historyLimit: 2,
        client: { rest: { get } },
        channelConfig: { allowed: true, users: ["111"] },
      });
      ctx.cfg = { ...ctx.cfg, channels: { discord: { contextVisibility: mode } } };
      const result = await buildContext(ctx);
      const expected = mode === "all" ? ["899", "900"] : ["899"];

      expect(result?.ctxPayload.InboundHistory?.map((entry) => entry.messageId)).toEqual(expected);
      expect(result?.ctxPayload.Body).toContain("permitted discussion");
      if (mode === "all") {
        expect(result?.ctxPayload.Body).toContain("blocked discussion");
      } else {
        expect(result?.ctxPayload.Body).not.toContain("blocked discussion");
      }
      expect(get).toHaveBeenCalledTimes(1);
    },
  );

  it("resolves role-only visibility on a cold map using the account's native guild member read", async () => {
    const get = vi.fn(async (route: string) =>
      route === "/channels/c1/messages"
        ? [nativeMessage(900, "role-permitted discussion")]
        : { roles: ["333"], nick: "Reviewer" },
    );
    const ctx = await recentContext({
      client: { rest: { get } },
      channelConfig: { allowed: true, roles: ["333"] },
    });
    ctx.cfg = { ...ctx.cfg, channels: { discord: { contextVisibility: "allowlist" } } };
    const result = await buildContext(ctx);

    expect(result?.ctxPayload.InboundHistory).toEqual([
      expect.objectContaining({ messageId: "900", body: "role-permitted discussion" }),
    ]);
    expect(get).toHaveBeenCalledWith("/guilds/g1/members/111");
  });

  it.each(["unchanged-image", "replacement-image"])(
    "uses native edits and deletions while validating cached media against %s",
    async (attachmentId) => {
      const cached = cachedEntry("900", "stale caption");
      cached.mediaIds = ["attachment:unchanged-image"];
      cached.media = [
        {
          messageId: "900",
          path: "/tmp/unchanged-image.png",
          contentType: "image/png",
          kind: "image",
        },
      ];
      const fresh = nativeMessage(900, "current caption", {
        edited_timestamp: new Date(startedAt + 9_500).toISOString(),
        attachments: [
          {
            id: attachmentId,
            filename: "image.png",
            size: 40,
            url: "https://cdn.discordapp.com/image.png",
            proxy_url: "https://media.discordapp.net/image.png",
            content_type: "image/png",
          },
        ],
      });
      const result = await buildContext(
        await recentContext({
          client: { rest: { get: vi.fn().mockResolvedValue([fresh]) } },
          guildHistories: new Map([["c1", [cachedEntry("899", "deleted discussion"), cached]]]),
        }),
      );

      expect(result?.ctxPayload.Body).toContain("current caption");
      expect(result?.ctxPayload.Body).not.toContain("stale caption");
      expect(result?.ctxPayload.Body).not.toContain("deleted discussion");
      expect(result?.ctxPayload.InboundHistory).toEqual([
        expect.objectContaining({
          messageId: "900",
          body: expect.stringContaining("current caption"),
        }),
      ]);
      if (attachmentId === "unchanged-image") {
        expect(result?.ctxPayload.InboundHistory?.[0]?.media).toEqual(cached.media);
        expect(result?.ctxPayload.Body).not.toContain("historical attachment unavailable");
      } else {
        expect(result?.ctxPayload.InboundHistory?.[0]?.media).toBeUndefined();
        expect(result?.ctxPayload.Body).toContain("historical attachment unavailable");
      }
    },
  );

  it("keeps an addressed turn and logs omission when native history fails, without a stale fallback", async () => {
    const error = vi.fn();
    const result = await buildContext(
      await recentContext({
        runtime: { log: vi.fn(), error },
        client: { rest: { get: vi.fn().mockRejectedValue(new Error("Missing Access")) } },
        guildHistories: new Map([["c1", [cachedEntry("900", "stale private discussion")]]]),
      }),
    );

    expect(result?.ctxPayload.Body).toContain("addressed current turn");
    expect(result?.ctxPayload.Body).not.toContain("stale private discussion");
    expect(result?.ctxPayload.InboundHistory).toEqual([]);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("recent history omitted"));
  });

  it("does no automatic history transport when historyLimit is zero", async () => {
    const get = vi.fn().mockRejectedValue(new Error("must not fetch"));
    const result = await buildContext(
      await recentContext({
        historyLimit: 0,
        client: { rest: { get } },
        guildHistories: new Map([["c1", [cachedEntry("900", "stale discussion")]]]),
      }),
    );

    expect(get).not.toHaveBeenCalled();
    expect(result?.ctxPayload.InboundHistory).toBeUndefined();
    expect(result?.ctxPayload.Body).toContain("addressed current turn");
    expect(result?.ctxPayload.Body).not.toContain("stale discussion");
  });

  it("excludes pre-reset messages using the bound session rather than the channel route", async () => {
    const ctx = await recentContext({
      boundSessionKey: "agent:main:subagent:bound",
      client: {
        rest: { get: vi.fn().mockResolvedValue([nativeMessage(900), nativeMessage(899)]) },
      },
    });
    await upsertSessionEntry({
      agentId: ctx.route.agentId,
      storePath: ctx.cfg.session?.store,
      sessionKey: ctx.boundSessionKey!,
      entry: {
        sessionId: "reset-session",
        lifecycleRevision: "reset-revision",
        updatedAt: startedAt + 9_000,
        sessionStartedAt: startedAt + 9_000,
      },
    });
    const result = await buildContext(ctx);

    expect(result?.ctxPayload.InboundHistory?.map((entry) => entry.messageId)).toEqual(["900"]);
    expect(result?.ctxPayload.Body).not.toContain("discussion-899");
    expect(result?.ctxPayload.SessionKey).toBe(ctx.boundSessionKey);
  });

  it("does not recover automatic history into a reset tombstone", async () => {
    const get = vi.fn().mockResolvedValue([nativeMessage(900)]);
    const ctx = await recentContext({ client: { rest: { get } } });
    await upsertSessionEntry({
      agentId: ctx.route.agentId,
      storePath: ctx.cfg.session?.store,
      sessionKey: ctx.route.sessionKey,
      entry: { sessionId: "pending-reset", updatedAt: 0, sessionStartedAt: startedAt },
    });
    const result = await buildContext(ctx);
    expect(result?.ctxPayload.InboundHistory).toEqual([]);
    expect(result?.ctxPayload.Body).toContain("addressed current turn");
    expect(get).not.toHaveBeenCalled();
  });

  it.each(["abort", "policy", "reset", "tombstone"] as const)(
    "does not publish fetched context after %s changes while awaiting REST",
    async (kind) => {
      const controller = new AbortController();
      let policyCurrent = true;
      const ctx = await recentContext({
        abortSignal: controller.signal,
        isPolicyCurrent: () => policyCurrent,
      });
      const scope = {
        agentId: ctx.route.agentId,
        storePath: ctx.cfg.session?.store,
        sessionKey: ctx.route.sessionKey,
      };
      await upsertSessionEntry({
        ...scope,
        entry: {
          sessionId: "same-session",
          lifecycleRevision: "before",
          updatedAt: startedAt,
          sessionStartedAt: startedAt,
        },
      });
      const get = vi.fn(async () => {
        if (kind === "abort") {
          controller.abort();
        } else if (kind === "policy") {
          policyCurrent = false;
        } else {
          await upsertSessionEntry({
            ...scope,
            entry: {
              sessionId: "same-session",
              lifecycleRevision: kind === "tombstone" ? "before" : "after",
              updatedAt: kind === "tombstone" ? 0 : startedAt + 9_000,
              sessionStartedAt: kind === "tombstone" ? startedAt : startedAt + 9_000,
            },
          });
        }
        return [nativeMessage(900)];
      });
      Object.assign(ctx.client, { rest: { get } });

      expect(await buildContext(ctx)).toBeNull();
    },
  );

  it("reads only the active thread, not its parent, and ignores cross-room and future rows", async () => {
    const get = vi.fn().mockResolvedValue([
      nativeMessage(1000, "current duplicate", { channel_id: "thread-1" }),
      nativeMessage(999, "future discussion", {
        channel_id: "thread-1",
        timestamp: new Date(startedAt + 11_000).toISOString(),
      }),
      nativeMessage(900, "thread discussion", { channel_id: "thread-1" }),
      nativeMessage(899, "parent discussion"),
    ]);
    const ctx = await recentContext({
      messageChannelId: "thread-1",
      message: {
        id: "1000",
        channelId: "thread-1",
        timestamp: new Date(startedAt + 10_000).toISOString(),
        attachments: [],
      },
      threadChannel: { id: "thread-1", name: "Thread" },
      threadParentId: "c1",
      threadParentName: "general",
      threadParentType: ChannelType.GuildText,
      channelConfig: { allowed: true, includeThreadStarter: false },
      client: { rest: { get } },
    });
    const result = await buildContext(ctx);

    expect(result?.ctxPayload.InboundHistory?.map((entry) => entry.messageId)).toEqual(["900"]);
    expect(result?.ctxPayload.Body).not.toContain("parent discussion");
    expect(result?.ctxPayload.Body).not.toContain("future discussion");
    expect(get).toHaveBeenCalledWith("/channels/thread-1/messages", { before: "1000", limit: 20 });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("leaves ordinary auto-thread parent history excluded", async () => {
    const get = vi.fn().mockResolvedValue({ thread: { id: "auto-thread-1" } });
    const result = await buildContext(
      await recentContext({
        channelConfig: { allowed: true, autoThread: true },
        client: { rest: { get } },
        guildHistories: new Map([["c1", [cachedEntry("900", "parent discussion")]]]),
      }),
    );

    expect(result?.ctxPayload.MessageThreadId).toBe("auto-thread-1");
    expect(result?.ctxPayload.Body).not.toContain("parent discussion");
    expect(get.mock.calls.some(([route]) => route === "/channels/c1/messages")).toBe(false);
  });

  it("uses each selected account's client without sharing recovered history", async () => {
    const first = await buildContext(
      await recentContext({
        accountId: "one",
        client: {
          rest: {
            get: vi.fn().mockResolvedValue([nativeMessage(900, "first account discussion")]),
          },
        },
      }),
    );
    const second = await buildContext(
      await recentContext({
        accountId: "two",
        client: {
          rest: {
            get: vi.fn().mockResolvedValue([nativeMessage(900, "second account discussion")]),
          },
        },
      }),
    );

    expect(first?.ctxPayload.Body).toContain("first account discussion");
    expect(second?.ctxPayload.Body).toContain("second account discussion");
    expect(second?.ctxPayload.Body).not.toContain("first account discussion");
  });

  it.each([undefined, false, true, "mentions"] as const)(
    "retains other bots as context independently of allowBots=%s",
    async (allowBots) => {
      const bot = { ...nativeMessage(900).author, id: "other-bot", bot: true };
      const reply = {
        author: bot,
        type: MessageType.Reply,
        mentions: [{ ...bot, id: "self" }],
      };
      const ctx = await recentContext({
        botUserId: "self",
        discordConfig: { allowBots },
        client: {
          rest: {
            get: vi
              .fn()
              .mockResolvedValue([
                nativeMessage(900, "own bot output", { author: { ...bot, id: "self" } }),
                nativeMessage(899, "other bot output", { author: bot }),
                nativeMessage(898, "human discussion"),
                nativeMessage(897, "passive reply ping", reply),
                nativeMessage(896, "<@self> active bot reply", reply),
                nativeMessage(895, "history-helper, assist", { author: bot }),
                nativeMessage(894, "`history-helper`", reply),
              ]),
          },
        },
      });
      ctx.cfg = { ...ctx.cfg, messages: { groupChat: { mentionPatterns: ["history-helper"] } } };
      const result = await buildContext(ctx);

      expect(result?.ctxPayload.InboundHistory?.map((entry) => entry.messageId)).toEqual([
        "894",
        "895",
        "896",
        "897",
        "898",
        "899",
      ]);
      expect(result?.ctxPayload.Body).not.toContain("own bot output");
    },
  );
});
