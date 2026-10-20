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
  createThreadClient,
  DEFAULT_PREFLIGHT_CFG,
} from "./message-handler.preflight.test-helpers.js";

beforeEach(() => sessionBindingTesting.resetSessionBindingAdaptersForTests());
afterEach(() => sessionBindingTesting.resetSessionBindingAdaptersForTests());

const botThread = { ownerId: "openclaw-bot", admitted: true };

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
    { ...botThread, name: "bot-created thread", requireMentionInBotThreads: false },
    { ...botThread, name: "automatically created thread", autoThread: true },
    {
      ...botThread,
      name: "strict thread explicit mention",
      requireMentionInBotThreads: true,
      mentioned: true,
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
  ])("checks unmentioned follow-ups in $name", async (scenario) => {
    const parentId = `parent-${scenario.name}`;
    const channelId = `thread-${scenario.name}`;
    const message = createDiscordMessage({
      id: "unmentioned-follow-up",
      channelId,
      content: scenario.mentioned
        ? "<@openclaw-bot> Can you explain the next step?"
        : "Can you explain the next step?",
      mentionedUsers: scenario.mentioned ? [{ id: "openclaw-bot" }] : [],
      referencedMessage: scenario.replyToBot
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
        client: createThreadClient({ threadId: channelId, parentId, ownerId: scenario.ownerId }),
      }),
      groupPolicy: "allowlist",
      guildEntries: {
        "guild-1": {
          requireMention: true,
          requireMentionInBotThreads: scenario.guildRequirement,
          channels: {
            [parentId]: {
              enabled: true,
              requireMention: scenario.normalRequirement ?? true,
              requireMentionInBotThreads: scenario.requireMentionInBotThreads,
              autoThread: scenario.autoThread,
              users: scenario.users ?? ["111111111111111111"],
            },
          },
        },
      },
    });
    if (!scenario.admitted) {
      expect(result).toBeNull();
      return;
    }
    expect(result).toMatchObject({
      shouldRequireMention: scenario.requireMentionInBotThreads === true,
      messageChannelId: channelId,
      effectiveWasMentioned: scenario.mentioned === true,
    });
  });
});
