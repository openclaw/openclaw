import { installDiscordIngressTestRuntime } from "../test-support/ingress-runtime.js";

installDiscordIngressTestRuntime();
import { testing as sessionBindingTesting } from "openclaw/plugin-sdk/conversation-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DiscordConfigSchema } from "../config-schema.js";
import { preflightDiscordMessage } from "./message-handler.preflight.js";
import {
  createDiscordMessage,
  createDiscordPreflightArgs,
  createGuildEvent,
  createGuildTextClient,
  createThreadClient,
  DEFAULT_PREFLIGHT_CFG,
} from "./message-handler.preflight.test-helpers.js";

beforeEach(() => sessionBindingTesting.resetSessionBindingAdaptersForTests());
afterEach(() => sessionBindingTesting.resetSessionBindingAdaptersForTests());

describe("Discord bot-owned thread mention gating", () => {
  it("validates guild and channel overrides without adding a default", () => {
    const config = DiscordConfigSchema.parse({
      guilds: {
        "123": {
          requireMentionInBotThreads: false,
          channels: { "456": { requireMentionInBotThreads: true }, "789": {} },
        },
      },
    });
    expect(config.guilds?.["123"]?.requireMentionInBotThreads).toBe(false);
    expect(config.guilds?.["123"]?.channels?.["456"]?.requireMentionInBotThreads).toBe(true);
    expect(config.guilds?.["123"]?.channels?.["789"]?.requireMentionInBotThreads).toBeUndefined();
    expect(
      DiscordConfigSchema.safeParse({ guilds: { "123": { requireMentionInBotThreads: "false" } } })
        .success,
    ).toBe(false);
  });
  it.each([
    {
      name: "bot-created thread",
      autoThread: undefined,
      ownerId: "openclaw-bot",
      requireMentionInBotThreads: false,
      admitted: true,
    },
    {
      name: "bot-created thread with autoThread off",
      autoThread: false,
      requireMentionInBotThreads: false,
      ownerId: "openclaw-bot",
      admitted: true,
    },
    {
      name: "automatically created thread",
      autoThread: true,
      ownerId: "openclaw-bot",
      admitted: true,
    },
    { name: "omitted override", ownerId: "openclaw-bot", admitted: false },
    { name: "guild override", ownerId: "openclaw-bot", guildRequirement: false, admitted: true },
    {
      name: "channel override wins",
      ownerId: "openclaw-bot",
      guildRequirement: false,
      requireMentionInBotThreads: true,
      admitted: false,
    },
    {
      name: "strict automatic thread",
      ownerId: "openclaw-bot",
      autoThread: true,
      requireMentionInBotThreads: true,
      admitted: false,
    },
    {
      name: "strict open-channel thread",
      ownerId: "openclaw-bot",
      normalRequirement: false,
      requireMentionInBotThreads: true,
      admitted: false,
    },
    {
      name: "strict thread explicit mention",
      ownerId: "openclaw-bot",
      requireMentionInBotThreads: true,
      mentioned: true,
      admitted: true,
    },
    {
      name: "strict thread implicit reply",
      ownerId: "openclaw-bot",
      requireMentionInBotThreads: true,
      replyToBot: true,
      admitted: false,
    },
    {
      name: "human-created thread",
      requireMentionInBotThreads: false,
      ownerId: "111111111111111111",
      admitted: false,
    },
    {
      name: "another bot's thread",
      requireMentionInBotThreads: false,
      ownerId: "other-bot",
      admitted: false,
    },
    {
      name: "unknown thread owner",
      requireMentionInBotThreads: false,
      ownerId: "",
      admitted: false,
    },
    {
      name: "parent channel",
      requireMentionInBotThreads: false,
      ownerId: "openclaw-bot",
      parentMessage: true,
      admitted: false,
    },
    {
      name: "disallowed sender in bot-created thread",
      requireMentionInBotThreads: false,
      ownerId: "openclaw-bot",
      users: ["222222222222222222"],
      admitted: false,
    },
  ])(
    "checks unmentioned follow-ups in $name",
    async ({
      name,
      autoThread,
      ownerId,
      parentMessage,
      users,
      admitted,
      requireMentionInBotThreads,
      guildRequirement,
      normalRequirement,
      mentioned,
      replyToBot,
    }) => {
      const parentId = `parent-${name}`;
      const threadId = `thread-${name}`;
      const channelId = parentMessage ? parentId : threadId;
      const message = createDiscordMessage({
        id: "unmentioned-follow-up",
        channelId,
        content: mentioned
          ? "<@openclaw-bot> Can you explain the next step?"
          : "Can you explain the next step?",
        mentionedUsers: mentioned ? [{ id: "openclaw-bot" }] : [],
        referencedMessage: replyToBot
          ? createDiscordMessage({
              id: "bot-root",
              channelId,
              content: "Started this thread",
              author: { id: "openclaw-bot", bot: true },
            })
          : undefined,
        author: { id: "111111111111111111", bot: false, username: "Pat" },
      });
      const result = await preflightDiscordMessage({
        ...createDiscordPreflightArgs({
          cfg: DEFAULT_PREFLIGHT_CFG,
          discordConfig: {},
          data: createGuildEvent({
            channelId,
            guildId: "guild-1",
            author: message.author,
            message,
          }),
          client: parentMessage
            ? createGuildTextClient(parentId)
            : createThreadClient({ threadId, parentId, ownerId }),
        }),
        groupPolicy: "allowlist",
        guildEntries: {
          "guild-1": {
            requireMention: true,
            requireMentionInBotThreads: guildRequirement,
            channels: {
              [parentId]: {
                enabled: true,
                requireMention: normalRequirement ?? true,
                requireMentionInBotThreads,
                autoThread,
                users: users ?? ["111111111111111111"],
              },
            },
          },
        },
      });
      if (!admitted) {
        expect(result).toBeNull();
        return;
      }
      expect(result?.shouldRequireMention).toBe(requireMentionInBotThreads === true);
      expect(result?.messageChannelId).toBe(threadId);
      expect(result?.wasMentioned).toBe(mentioned === true);
    },
  );
});
