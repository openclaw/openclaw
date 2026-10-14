import { installDiscordIngressTestRuntime } from "../test-support/ingress-runtime.js";

installDiscordIngressTestRuntime();
import { testing as sessionBindingTesting } from "openclaw/plugin-sdk/conversation-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiscordConfigSchema } from "../config-schema.js";
import { preflightDiscordMessage } from "./message-handler.preflight.js";
import {
  createDiscordMessage,
  createDiscordPreflightArgs,
  createGuildEvent,
  createThreadClient,
  DEFAULT_PREFLIGHT_CFG,
} from "./message-handler.preflight.test-helpers.js";

vi.mock("openclaw/plugin-sdk/channel-mention-gating", async (importOriginal) => {
  const sdk = {
    ...(await importOriginal<typeof import("openclaw/plugin-sdk/channel-mention-gating")>()),
  };
  // The published 2026.9.6 host has the evaluator, but not the bot-thread helper.
  Reflect.deleteProperty(sdk, "resolveBotThreadMentionPolicy");
  return sdk;
});

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
      ownerId: "openclaw-bot",
      requireMentionInBotThreads: false,
      admitted: true,
    },
    {
      name: "automatically created thread",
      autoThread: true,
      ownerId: "openclaw-bot",
      admitted: true,
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
      guildRequirement: false,
      normalRequirement: false,
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
      const channelId = threadId;
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
          client: createThreadClient({ threadId, parentId, ownerId }),
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
