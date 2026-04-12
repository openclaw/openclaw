/**
 * Tests that preflightDiscordMessage passively populates the directory cache
 * from the message author and mentionedUsers, enabling outbound
 * rewriteDiscordKnownMentions() to resolve @name → <@ID> for bot→bot @mention
 * chains without prompt-level ID injection.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetDiscordDirectoryCacheForTest,
  rememberDiscordDirectoryUser,
  resolveDiscordDirectoryUserId,
} from "../directory-cache.js";
import { rewriteDiscordKnownMentions } from "../mentions.js";
import { preflightDiscordMessage } from "./message-handler.preflight.js";
import {
  createDiscordMessage,
  createDiscordPreflightArgs,
  createGuildEvent,
  createGuildTextClient,
  DEFAULT_PREFLIGHT_CFG,
} from "./message-handler.preflight.test-helpers.js";

const GUILD_ID = "guild-1";
const CHANNEL_ID = "channel-1";
const BOT_USER_ID = "bot-self";

function makeAllowedGuildEntries() {
  return {
    [GUILD_ID]: {
      id: GUILD_ID,
      channels: {
        [CHANNEL_ID]: { allow: true, enabled: true, requireMention: false },
      },
    },
  };
}

function makeBaseParams(author: {
  id: string;
  bot: boolean;
  username: string;
  globalName?: string;
}) {
  const carbonAuthor = author as unknown as import("@buape/carbon").Message["author"];
  const message = createDiscordMessage({
    id: "m-1",
    channelId: CHANNEL_ID,
    content: "hello",
    author,
  });
  return createDiscordPreflightArgs({
    cfg: DEFAULT_PREFLIGHT_CFG,
    discordConfig: { allowBots: true } as NonNullable<
      import("openclaw/plugin-sdk/config-runtime").OpenClawConfig["channels"]
    >["discord"],
    data: createGuildEvent({
      channelId: CHANNEL_ID,
      guildId: GUILD_ID,
      author: carbonAuthor,
      message,
    }),
    client: createGuildTextClient(CHANNEL_ID),
    botUserId: BOT_USER_ID,
  });
}

describe("preflightDiscordMessage: directory cache population", () => {
  beforeEach(() => {
    __resetDiscordDirectoryCacheForTest();
  });

  it("caches the message author username so outbound rewrite resolves @name → <@ID>", async () => {
    const author = { id: "1488478869458780280", bot: true, username: "架构师" };
    const params = makeBaseParams(author);

    await preflightDiscordMessage({ ...params, guildEntries: makeAllowedGuildEntries() });

    const resolved = resolveDiscordDirectoryUserId({
      accountId: "default",
      handle: "架构师",
    });
    expect(resolved).toBe("1488478869458780280");
  });

  it("rewrites @name in outbound text after author passes through preflight", async () => {
    // Simulate bot A's message arriving — bot A is the architect
    const author = { id: "1488478869458780280", bot: true, username: "架构师" };
    const params = makeBaseParams(author);

    await preflightDiscordMessage({ ...params, guildEntries: makeAllowedGuildEntries() });

    // Now another bot tries to mention the architect by display name
    const rewritten = rewriteDiscordKnownMentions("@架构师 请复核确认", { accountId: "default" });
    expect(rewritten).toBe("<@1488478869458780280> 请复核确认");
  });

  it("caches globalName as an additional resolvable handle", async () => {
    const author = {
      id: "1488480784422535208",
      bot: true,
      username: "backend_eng",
      globalName: "后端工程师",
    };
    const message = createDiscordMessage({
      id: "m-2",
      channelId: CHANNEL_ID,
      content: "api done",
      author,
    });
    const params = createDiscordPreflightArgs({
      cfg: DEFAULT_PREFLIGHT_CFG,
      discordConfig: { allowBots: true } as NonNullable<
        import("openclaw/plugin-sdk/config-runtime").OpenClawConfig["channels"]
      >["discord"],
      data: {
        ...createGuildEvent({
          channelId: CHANNEL_ID,
          guildId: GUILD_ID,
          author: author as unknown as import("@buape/carbon").Message["author"],
          message,
        }),
        // Inject globalName via the author object (as Carbon exposes it)
        author: {
          ...author,
          globalName: "后端工程师",
        } as unknown as import("@buape/carbon").Message["author"],
      } as import("./listeners.js").DiscordMessageEvent,
      client: createGuildTextClient(CHANNEL_ID),
      botUserId: BOT_USER_ID,
    });

    await preflightDiscordMessage({ ...params, guildEntries: makeAllowedGuildEntries() });

    // Both the username and globalName should resolve
    expect(resolveDiscordDirectoryUserId({ accountId: "default", handle: "backend_eng" })).toBe(
      "1488480784422535208",
    );
    expect(resolveDiscordDirectoryUserId({ accountId: "default", handle: "后端工程师" })).toBe(
      "1488480784422535208",
    );
  });

  it("caches users listed in mentionedUsers so the receiver learns their IDs", async () => {
    const botSelf = { id: BOT_USER_ID, bot: true, username: "director_bot" };
    const mentionedBot = { id: "1488479656549158922", username: "前端工程师" };
    const message = {
      id: "m-3",
      content: "<@" + BOT_USER_ID + "> check this",
      channelId: CHANNEL_ID,
      timestamp: new Date().toISOString(),
      attachments: [],
      mentionedUsers: [{ ...mentionedBot }],
      mentionedRoles: [],
      mentionedEveryone: false,
      author: botSelf,
    } as unknown as import("@buape/carbon").Message;

    const params = createDiscordPreflightArgs({
      cfg: DEFAULT_PREFLIGHT_CFG,
      discordConfig: { allowBots: true } as NonNullable<
        import("openclaw/plugin-sdk/config-runtime").OpenClawConfig["channels"]
      >["discord"],
      data: createGuildEvent({
        channelId: CHANNEL_ID,
        guildId: GUILD_ID,
        author: botSelf as unknown as import("@buape/carbon").Message["author"],
        message,
      }),
      client: createGuildTextClient(CHANNEL_ID),
      botUserId: BOT_USER_ID,
    });

    await preflightDiscordMessage({ ...params, guildEntries: makeAllowedGuildEntries() });

    // The mentioned bot's username should now be resolvable
    expect(resolveDiscordDirectoryUserId({ accountId: "default", handle: "前端工程师" })).toBe(
      "1488479656549158922",
    );
  });

  it("cross-account fallback resolves handles cached by another account", () => {
    // Simulate bot A (accountId="architect") caching a user during preflight
    rememberDiscordDirectoryUser({
      accountId: "architect",
      userId: "1488480784422535208",
      handles: ["后端工程师"],
    });

    // Bot B (accountId="qa") should also be able to resolve the handle
    // via the cross-account fallback
    expect(resolveDiscordDirectoryUserId({ accountId: "qa", handle: "后端工程师" })).toBe(
      "1488480784422535208",
    );

    // Rewrite should also work from a different account
    const rewritten = rewriteDiscordKnownMentions("@后端工程师 请确认", { accountId: "qa" });
    expect(rewritten).toBe("<@1488480784422535208> 请确认");
  });
});
