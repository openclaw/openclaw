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
const humanId = "111111111111111111";

describe("Discord bot-owned thread mention gating", () => {
  it("validates guild and channel overrides without adding a default", () => {
    const guild = DiscordConfigSchema.parse({
      guilds: {
        "123": {
          requireMentionInBotThreads: false,
          channels: { "456": { requireMentionInBotThreads: true }, "789": {} },
        },
      },
    }).guilds?.["123"];
    expect({
      guild: guild?.requireMentionInBotThreads,
      channel: guild?.channels?.["456"]?.requireMentionInBotThreads,
      unset: guild?.channels?.["789"]?.requireMentionInBotThreads,
    }).toEqual({ guild: false, channel: true, unset: undefined });
    const invalid = { ...guild, requireMentionInBotThreads: "false" };
    expect(DiscordConfigSchema.safeParse({ guilds: { "123": invalid } }).success).toBe(false);
  });
  it.each<{
    name: string;
    ownerId: string;
    admitted: boolean;
    strict?: boolean;
    autoThread?: boolean;
    mentioned?: boolean;
    relaxedParent?: boolean;
    replyToBot?: boolean;
    users?: string[];
  }>([
    { ...botThread, name: "bot-created thread", strict: false },
    { ...botThread, name: "automatically created thread", autoThread: true },
    { ...botThread, name: "strict explicit mention", strict: true, mentioned: true },
    {
      name: "strict thread implicit reply",
      ownerId: "openclaw-bot",
      relaxedParent: true,
      strict: true,
      replyToBot: true,
      admitted: false,
    },
    { name: "human-created thread", strict: false, ownerId: humanId, admitted: false },
    {
      name: "disallowed sender in bot-created thread",
      strict: false,
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
      content: scenario.mentioned ? "<@openclaw-bot> next?" : "next?",
      mentionedUsers: scenario.mentioned ? [{ id: "openclaw-bot" }] : [],
      referencedMessage: scenario.replyToBot
        ? createDiscordMessage({
            id: "bot-root",
            channelId,
            content: "Started this thread",
            author: { id: "openclaw-bot", bot: true },
          })
        : undefined,
      author: { id: humanId, bot: false, username: "Pat" },
    });
    const result = await preflightDiscordMessage({
      ...createDiscordPreflightArgs({
        cfg: DEFAULT_PREFLIGHT_CFG,
        discordConfig: {},
        data: createGuildEvent({ channelId, guildId: "guild-1", author: message.author, message }),
        client: createThreadClient({ threadId: channelId, parentId, ownerId: scenario.ownerId }),
      }),
      groupPolicy: "allowlist",
      guildEntries: {
        "guild-1": {
          requireMention: true,
          requireMentionInBotThreads: scenario.relaxedParent ? false : undefined,
          channels: {
            [parentId]: {
              enabled: true,
              requireMention: !scenario.relaxedParent,
              requireMentionInBotThreads: scenario.strict,
              autoThread: scenario.autoThread,
              users: scenario.users ?? [humanId],
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
      shouldRequireMention: scenario.strict === true,
      messageChannelId: channelId,
      effectiveWasMentioned: scenario.mentioned === true,
    });
  });
});
