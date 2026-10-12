import { ChannelType, ComponentType, MessageType } from "discord-api-types/v10";
import type { ChannelIngressQueueRecord } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import type { DiscordGatewayChannelInfo } from "../internal/gateway-channel-inventory.js";
import { createInternalTestClient } from "../internal/test-builders.test-support.js";
import type { DiscordGuildEntryResolved } from "./allow-list.js";
import { createDiscordStaleAmbientPendingDisposition } from "./ingress-stale-policy.js";
import type { DiscordLivePolicy } from "./live-policy.js";

// The policy's contract values, pinned here rather than exported for tests only.
const DISCORD_STALE_AMBIENT_BACKLOG_MS = 15 * 60 * 1_000;
const DISCORD_STALE_AMBIENT_BACKLOG_REASON = "stale-ambient-backlog";
const BOT_ID = "bot-1";
const NOW = 10 * DISCORD_STALE_AMBIENT_BACKLOG_MS;
const STALE_AT = NOW - DISCORD_STALE_AMBIENT_BACKLOG_MS - 1;
const FRESH_AT = NOW - 1_000;
const GENERAL: DiscordGatewayChannelInfo = {
  guildId: "g1",
  name: "general",
  type: ChannelType.GuildText,
};

const NAMED_AGENT_CFG = {
  agents: { list: [{ id: "main", identity: { name: "claw" } }] },
} as unknown as OpenClawConfig;

type PolicyOverrides = {
  cfg?: OpenClawConfig;
  discordConfig?: Record<string, unknown>;
  guildEntries?: Record<string, DiscordGuildEntryResolved>;
  isCurrent?: () => boolean;
  isConfigCurrent?: () => boolean;
};

function livePolicy(overrides: PolicyOverrides = {}): DiscordLivePolicy {
  return {
    isCurrent: overrides.isCurrent ?? (() => true),
    isConfigCurrent: overrides.isConfigCurrent ?? (() => true),
    accountId: "default",
    cfg: overrides.cfg ?? ({} as OpenClawConfig),
    discordConfig: overrides.discordConfig ?? {},
    guildEntries: overrides.guildEntries,
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

function rawMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "m1",
    channel_id: "c1",
    guild_id: "g1",
    content: "just chatting",
    timestamp: new Date(STALE_AT).toISOString(),
    mention_everyone: false,
    mentions: [],
    attachments: [],
    type: MessageType.Default,
    author: { id: "user-1", username: "alice" },
    ...overrides,
  };
}

function record(overrides: {
  payload?: unknown;
  receivedAt?: number;
}): ChannelIngressQueueRecord<unknown> {
  return {
    id: "m1",
    channelId: "discord",
    accountId: "a",
    queueName: "discord:a",
    payload:
      "payload" in overrides
        ? overrides.payload
        : { version: 1, receivedAt: STALE_AT, rawMessage: rawMessage() },
    receivedAt: overrides.receivedAt ?? STALE_AT,
    updatedAt: overrides.receivedAt ?? STALE_AT,
    laneKey: "channel:c1",
    attempts: 0,
  };
}

async function resolve(
  params: {
    message?: Record<string, unknown>;
    payload?: unknown;
    /** Receipt stored inside the payload when the gateway first admitted it. */
    payloadReceivedAt?: number;
    /** Receipt on the durable row itself. */
    durableReceivedAt?: number;
    channelInfo?: DiscordGatewayChannelInfo | undefined;
    hydrating?: boolean;
    botUserId?: string | undefined;
    readPolicy?: () => Promise<DiscordLivePolicy>;
  } & PolicyOverrides,
) {
  const policy = livePolicy(params);
  const disposition = createDiscordStaleAmbientPendingDisposition({
    botUserId: "botUserId" in params ? params.botUserId : BOT_ID,
    client: createInternalTestClient(),
    readPolicy: params.readPolicy ?? (async () => policy),
    resolveChannelInfo: () => ("channelInfo" in params ? params.channelInfo : GENERAL),
    isChannelInventoryHydrating: () => params.hydrating === true,
  });
  return await disposition(
    record({
      ...("payload" in params
        ? { payload: params.payload }
        : {
            payload: {
              version: 1,
              receivedAt: params.payloadReceivedAt ?? STALE_AT,
              rawMessage: rawMessage(params.message),
            },
          }),
      receivedAt: params.durableReceivedAt ?? params.payloadReceivedAt ?? STALE_AT,
    }),
    { laneKey: "channel:c1", now: NOW },
  );
}

describe("discord stale ambient pending disposition", () => {
  it("fails stale ambient guild backlog in a mention-gated channel", async () => {
    await expect(resolve({})).resolves.toMatchObject({
      kind: "fail",
      reason: DISCORD_STALE_AMBIENT_BACKLOG_REASON,
    });
  });

  it("preserves current work", async () => {
    await expect(
      resolve({
        message: { timestamp: new Date(FRESH_AT).toISOString() },
        payloadReceivedAt: FRESH_AT,
      }),
    ).resolves.toBeNull();
  });

  it("preserves direct messages", async () => {
    await expect(resolve({ message: { guild_id: undefined } })).resolves.toBeNull();
  });

  it("preserves mentioned work", async () => {
    await expect(resolve({ message: { mentions: [{ id: BOT_ID }] } })).resolves.toBeNull();
    await expect(resolve({ message: { mention_everyone: true } })).resolves.toBeNull();
    await expect(
      resolve({ message: { content: `hey <@${BOT_ID}> look`, mentions: [{ id: BOT_ID }] } }),
    ).resolves.toBeNull();
    // Preflight reads the native mentions array; a bare <@id> in text alone is not a mention.
    await expect(resolve({ message: { content: `hey <@${BOT_ID}> look` } })).resolves.toMatchObject(
      {
        reason: DISCORD_STALE_AMBIENT_BACKLOG_REASON,
      },
    );
    await expect(
      resolve({ message: { referenced_message: { author: { id: BOT_ID } } } }),
    ).resolves.toBeNull();
  });

  it("leaves every hydration-dependent row to claim-time preflight", async () => {
    // ClawSweeper rev 18: a mention-shaped frame with no mention metadata sends
    // preflight to REST hydration, whose outcome (or the raw bot mention
    // fallback when REST is unavailable) decides it. Pre-claim cannot know it.
    const botUserId = "123456789012345678";
    for (const message of [
      { content: `hi <@${botUserId}>`, mentions: [] },
      { content: `hi <@!${botUserId}>`, mentions: [] },
      { content: "", embeds: [{ title: `ping <@${botUserId}>` }], mentions: [] },
      // Hydration may still reveal metadata the stored frame lacks.
      { content: "hi <@987654321098765432>", mentions: [] },
      { content: "@everyone heads up", mentions: [], mention_everyone: false },
      { content: "@here heads up", mentions: [], mention_everyone: false },
      { content: "<@&555555555555555555> heads up", mentions: [], mention_roles: [] },
      { content: `hi \\<@${botUserId}>`, mentions: [] },
    ]) {
      await expect(resolve({ botUserId, message })).resolves.toBeNull();
    }
    // Controls with nothing left to hydrate stay decidable and expire: another
    // user's mention with its metadata, escaped and code-quoted bot mentions
    // beside that metadata, and plain unaddressed text.
    for (const message of [
      { content: "hi <@987654321098765432>", mentions: [{ id: "987654321098765432" }] },
      { content: `hi \\<@${botUserId}>`, mentions: [{ id: "987654321098765432" }] },
      { content: `hi \`<@${botUserId}>\``, mentions: [{ id: "987654321098765432" }] },
      { content: "just chatting", mentions: [] },
    ]) {
      await expect(resolve({ botUserId, message })).resolves.toMatchObject({
        reason: DISCORD_STALE_AMBIENT_BACKLOG_REASON,
      });
    }
  });

  it("preserves replied work", async () => {
    await expect(
      resolve({
        message: {
          type: MessageType.Reply,
          message_reference: { message_id: "m0", channel_id: "c1" },
        },
      }),
    ).resolves.toBeNull();
  });

  it("drops a stale reply to someone else, but keeps one whose target is unknown", async () => {
    const reply = {
      type: MessageType.Reply,
      message_reference: { message_id: "m0", channel_id: "c1" },
    };
    // Canonical nested target: matching id, author and a body, so preflight
    // takes it as is and never re-fetches it.
    const target = (authorId: string, overrides: Record<string, unknown> = {}) => ({
      id: "m0",
      channel_id: "c1",
      content: "earlier answer",
      timestamp: new Date(STALE_AT - 1_000).toISOString(),
      mentions: [],
      attachments: [],
      embeds: [],
      author: { id: authorId, username: authorId },
      ...overrides,
    });
    await expect(
      resolve({ message: { ...reply, referenced_message: target("user-2") } }),
    ).resolves.toMatchObject({ reason: DISCORD_STALE_AMBIENT_BACKLOG_REASON });
    await expect(
      resolve({ message: { ...reply, referenced_message: target(BOT_ID) } }),
    ).resolves.toBeNull();
    await expect(resolve({ message: reply })).resolves.toBeNull();
  });

  it("leaves a stale reply whose target preflight would re-fetch to claim-time preflight", async () => {
    // 🌊 on 8f5f545fec6: a nested target without a matching id or without a
    // body makes preflight re-fetch it, and REST may return the bot as its
    // author (reply to the bot is an implicit mention). Pre-claim cannot know.
    const reply = {
      type: MessageType.Reply,
      message_reference: { message_id: "m0", channel_id: "c1" },
    };
    for (const authorId of ["user-2", BOT_ID]) {
      const author = { id: authorId, username: authorId };
      for (const referenced_message of [
        { author, content: "earlier answer" },
        { id: "m9", author, content: "earlier answer", attachments: [] },
        { id: "m0", author, content: "", attachments: [], embeds: [] },
      ]) {
        await expect(resolve({ message: { ...reply, referenced_message } })).resolves.toBeNull();
      }
    }
  });

  it("preserves command-like work", async () => {
    await expect(resolve({ message: { content: "/status" } })).resolves.toBeNull();
  });

  it("reads the canonical text of an empty-content embed message", async () => {
    // Preflight reads commands from embed title/description, but runs mention
    // patterns on typed content only, so a name in an embed is not a mention.
    await expect(
      resolve({
        cfg: NAMED_AGENT_CFG,
        message: { content: "", embeds: [{ title: "claw please look" }] },
      }),
    ).resolves.toMatchObject({ reason: DISCORD_STALE_AMBIENT_BACKLOG_REASON });
    await expect(
      resolve({ message: { content: "", embeds: [{ description: "/status" }] } }),
    ).resolves.toBeNull();
    await expect(
      resolve({ message: { content: "", embeds: [{ title: `ping <@${BOT_ID}>` }] } }),
    ).resolves.toMatchObject({ reason: DISCORD_STALE_AMBIENT_BACKLOG_REASON });
    await expect(
      resolve({ message: { content: "", embeds: [{ title: "release notes" }] } }),
    ).resolves.toMatchObject({ reason: DISCORD_STALE_AMBIENT_BACKLOG_REASON });
  });

  it("reads the canonical text of a Components V2 text display", async () => {
    const components = (content: string) => [
      { type: ComponentType.Container, components: [{ type: ComponentType.TextDisplay, content }] },
    ];
    // Same rule as embeds: commands yes, mention patterns no.
    await expect(
      resolve({
        cfg: NAMED_AGENT_CFG,
        message: { content: "", components: components("claw have a look") },
      }),
    ).resolves.toMatchObject({ reason: DISCORD_STALE_AMBIENT_BACKLOG_REASON });
    await expect(
      resolve({ message: { content: "", components: components("/status") } }),
    ).resolves.toBeNull();
    await expect(
      resolve({ message: { content: "", components: components(`<@${BOT_ID}> hi`) } }),
    ).resolves.toMatchObject({ reason: DISCORD_STALE_AMBIENT_BACKLOG_REASON });
    await expect(
      resolve({ message: { content: "", components: components("deploy finished") } }),
    ).resolves.toMatchObject({ reason: DISCORD_STALE_AMBIENT_BACKLOG_REASON });
  });

  it("preserves threaded work and unknown channels", async () => {
    await expect(
      resolve({ channelInfo: { guildId: "g1", name: "triage", type: ChannelType.PublicThread } }),
    ).resolves.toBeNull();
    await expect(resolve({ channelInfo: undefined })).resolves.toBeNull();
    await expect(
      resolve({ channelInfo: { guildId: "g1", name: "forum", type: ChannelType.GuildForum } }),
    ).resolves.toBeNull();
  });

  it("defers instead of failing while the guild inventory is hydrating", async () => {
    await expect(resolve({ hydrating: true })).resolves.toEqual({ kind: "defer" });
    // A hydrating guild never leaks an unknown channel into a claimable row.
    await expect(resolve({ hydrating: true, channelInfo: undefined })).resolves.toEqual({
      kind: "defer",
    });
    // Work is still preserved ahead of the hydration check.
    await expect(
      resolve({ hydrating: true, message: { mentions: [{ id: BOT_ID }] } }),
    ).resolves.toBeNull();
    await expect(
      resolve({
        hydrating: true,
        message: { timestamp: new Date(FRESH_AT).toISOString() },
        payloadReceivedAt: FRESH_AT,
      }),
    ).resolves.toBeNull();
  });

  it("preserves ambient work in configured direct-open channels", async () => {
    // requireMention: false means ambient guild chatter IS this channel's work.
    await expect(resolve({ guildEntries: { g1: { requireMention: false } } })).resolves.toBeNull();
    await expect(
      resolve({ guildEntries: { g1: { channels: { general: { requireMention: false } } } } }),
    ).resolves.toBeNull();
    await expect(
      resolve({
        guildEntries: {
          g1: { requireMention: true, channels: { "*": { requireMention: false } } },
        },
      }),
    ).resolves.toBeNull();
    // A category-level direct-open override reaches its child channel.
    await expect(
      resolve({
        channelInfo: { ...GENERAL, parentId: "cat1" },
        guildEntries: { g1: { channels: { cat1: { requireMention: false } } } },
      }),
    ).resolves.toBeNull();
  });

  it("uses the policy published now, not the one captured at startup", async () => {
    let guildEntries: Record<string, DiscordGuildEntryResolved> | undefined;
    const readPolicy = async () => livePolicy({ guildEntries });

    // Startup policy is mention-gated, so the backlog row is droppable.
    await expect(resolve({ readPolicy })).resolves.toMatchObject({
      reason: DISCORD_STALE_AMBIENT_BACKLOG_REASON,
    });

    // The operator opens the channel while the row is still pending.
    guildEntries = { g1: { requireMention: false } };
    await expect(resolve({ readPolicy })).resolves.toBeNull();

    // Re-gating it makes the same pending row droppable again.
    guildEntries = { g1: { requireMention: true } };
    await expect(resolve({ readPolicy })).resolves.toMatchObject({
      reason: DISCORD_STALE_AMBIENT_BACKLOG_REASON,
    });
  });

  it("uses the mention patterns published now", async () => {
    let cfg = {} as OpenClawConfig;
    const readPolicy = async () => livePolicy({ cfg });
    await expect(
      resolve({ readPolicy, message: { content: "claw can you look at this" } }),
    ).resolves.toMatchObject({ reason: DISCORD_STALE_AMBIENT_BACKLOG_REASON });

    cfg = NAMED_AGENT_CFG;
    await expect(
      resolve({ readPolicy, message: { content: "claw can you look at this" } }),
    ).resolves.toBeNull();
  });

  it("preserves work when the published policy went stale mid-decision", async () => {
    await expect(resolve({ isCurrent: () => false })).resolves.toBeNull();
    // Any edit to the config the classifier read (agents, broadcast, patterns).
    await expect(resolve({ isConfigCurrent: () => false })).resolves.toBeNull();
  });

  it("preserves work when the policy cannot be read", async () => {
    await expect(
      resolve({
        readPolicy: async () => {
          throw new Error("policy reader aborted");
        },
      }),
    ).resolves.toBeNull();
  });

  it("preserves work when the configured guild set cannot be resolved by id", async () => {
    // Slug and wildcard guild entries are config this policy cannot read here.
    await expect(resolve({ guildEntries: { "*": { requireMention: false } } })).resolves.toBeNull();
    await expect(
      resolve({ guildEntries: { "my-guild": { requireMention: false } } }),
    ).resolves.toBeNull();
  });

  it("preserves configured mention-pattern text and audio-only notes", async () => {
    await expect(
      resolve({ cfg: NAMED_AGENT_CFG, message: { content: "claw can you look at this" } }),
    ).resolves.toBeNull();
    // An agent configured only under keyed agents.entries is part of the roster too.
    await expect(
      resolve({
        cfg: {
          agents: { entries: { helper: { groupChat: { mentionPatterns: ["\\bhelper\\b"] } } } },
        } as unknown as OpenClawConfig,
        message: { content: "helper, can you look at this" },
      }),
    ).resolves.toBeNull();
    await expect(
      resolve({
        cfg: NAMED_AGENT_CFG,
        message: {
          content: "",
          attachments: [{ id: "a1", filename: "voice-message.ogg", url: "https://cdn/a.ogg" }],
        },
      }),
    ).resolves.toBeNull();
  });

  it("preserves an explicit broadcast-participant mention the provider policy would filter", async () => {
    // ClawSweeper rev 17: preflight's participant matcher uses unfiltered agent
    // patterns, so denyIn on the provider policy does not make "@helper" ambient.
    const cfg = {
      agents: { entries: { helper: { groupChat: { mentionPatterns: ["\\bhelper\\b"] } } } },
      broadcast: { "discord:c1": ["helper"] },
    } as unknown as OpenClawConfig;
    const denyHere = { mentionPatterns: { denyIn: ["c1"] } };
    await expect(
      resolve({
        cfg,
        discordConfig: denyHere,
        message: { content: "@helper can you look at this" },
      }),
    ).resolves.toBeNull();
    // Controls, each the way preflight decides them: no explicit address is no
    // participant mention, and without a broadcast entry the filtered patterns rule.
    await expect(
      resolve({
        cfg,
        discordConfig: denyHere,
        message: { content: "helper can you look at this" },
      }),
    ).resolves.toMatchObject({ reason: DISCORD_STALE_AMBIENT_BACKLOG_REASON });
    await expect(
      resolve({
        cfg: { agents: cfg.agents } as unknown as OpenClawConfig,
        discordConfig: denyHere,
        message: { content: "@helper can you look at this" },
      }),
    ).resolves.toMatchObject({ reason: DISCORD_STALE_AMBIENT_BACKLOG_REASON });
  });

  it("preserves work when the bot identity is unknown", async () => {
    await expect(resolve({ botUserId: undefined })).resolves.toBeNull();
  });

  it("keeps malformed and unresolved rows claimable", async () => {
    await expect(resolve({ payload: undefined })).resolves.toBeNull();
    await expect(resolve({ payload: { version: 1, receivedAt: STALE_AT } })).resolves.toBeNull();
    await expect(resolve({ payload: { rawMessage: { id: "m1" } } })).resolves.toBeNull();
    await expect(resolve({ message: { mentions: [{ id: 5 }] } })).resolves.toBeNull();
    await expect(resolve({ message: { attachments: undefined } })).resolves.toBeNull();
    await expect(resolve({ message: { content: undefined } })).resolves.toBeNull();
    await expect(resolve({ message: { timestamp: undefined } })).resolves.toBeNull();
    await expect(resolve({ message: { embeds: "not-an-array" } })).resolves.toBeNull();
    // Container-valid, but the text projection throws on the null embed.
    await expect(resolve({ message: { content: "", embeds: [null] } })).resolves.toBeNull();
  });

  it("keeps rows with an unsupported or missing payload version claimable", async () => {
    // Control: the same complete stale ambient row at version 1 is failed.
    await expect(resolve({})).resolves.toMatchObject({ kind: "fail" });
    for (const version of [2, 0, "1", undefined]) {
      await expect(
        resolve({ payload: { version, receivedAt: STALE_AT, rawMessage: rawMessage() } }),
      ).resolves.toBeNull();
    }
    await expect(
      resolve({ payload: { receivedAt: STALE_AT, rawMessage: rawMessage() } }),
    ).resolves.toBeNull();
  });

  it("uses the durable receipt time when it is newer than the stored frame", async () => {
    // A row re-admitted after downtime must not be aged from its origin timestamp.
    await expect(resolve({ durableReceivedAt: FRESH_AT })).resolves.toBeNull();
  });
});
