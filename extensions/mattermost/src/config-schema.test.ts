import { describe, expect, it } from "vitest";
import { MattermostConfigSchema } from "./config-schema-core.js";

const secretRef = { source: "env", provider: "default", id: "MATTERMOST_BOT_TOKEN" };

describe("MattermostConfigSchema", () => {
  it.each([
    [
      "SecretRef botToken at top-level",
      { botToken: secretRef, baseUrl: "https://chat.example.com" },
    ],
    [
      "SecretRef botToken on account",
      { accounts: { main: { botToken: secretRef, baseUrl: "https://chat.example.com" } } },
    ],
    ["replyToMode", { replyToMode: "all" }],
    [
      "per-chat-type reply threading",
      { replyToModeByChatType: { direct: "first", group: "all", channel: "off" } },
    ],
    ['dmPolicy="open" with wildcard allowFrom', { dmPolicy: "open", allowFrom: ["*"] }],
    [
      "documented streaming modes and progress config",
      {
        streaming: {
          mode: "progress",
          progress: { label: "Shelling", maxLines: 4, toolProgress: false, commandText: "status" },
          preview: { commandText: "raw" },
        },
        accounts: { quiet: { streaming: { mode: "off" } } },
      },
    ],
    [
      "groups on account",
      {
        accounts: {
          main: { baseUrl: "https://chat.example.com", groups: { "*": { requireMention: true } } },
        },
      },
    ],
    [
      "account-scoped message read action toggles",
      { actions: { messages: false }, accounts: { reader: { actions: { messages: true } } } },
    ],
    [
      "implicit mention policy at root and account scope",
      {
        implicitMentions: { threadParticipation: false },
        accounts: { main: { implicitMentions: { replyToBot: false } } },
      },
    ],
  ])("accepts %s", (_name, config) => {
    expect(MattermostConfigSchema.safeParse(config).success).toBe(true);
  });

  // Legacy streaming shapes are Doctor inputs; runtime accepts the nested shape only.
  it.each([
    ['dmPolicy="open" without wildcard allowFrom', { dmPolicy: "open" }],
    ["scalar streaming", { streaming: "partial" }],
    ["boolean streaming", { streaming: false }],
    ["flat blockStreaming", { blockStreaming: true }],
    ["flat chunkMode", { chunkMode: "newline" }],
    ["preview chunk", { streaming: { preview: { chunk: { minChars: 20 } } } }],
    ["progress commentary", { streaming: { progress: { commentary: true } } }],
    ["progress narration", { streaming: { progress: { narration: true } } }],
    ["unknown group properties", { groups: { "*": { requireMention: true, unknownProp: "bad" } } }],
    ["unsupported direct-message reply threading", { dm: { replyToMode: "all" } }],
    ["unknown per-chat-type reply threading keys", { replyToModeByChatType: { forum: "all" } }],
  ])("rejects %s", (_name, config) => {
    expect(MattermostConfigSchema.safeParse(config).success).toBe(false);
  });

  it("preserves root, account, and group thread mention overrides without defaults", () => {
    const result = MattermostConfigSchema.parse({
      requireMentionInBotThreads: false,
      groups: {
        "*": { requireMention: true, requireMentionInBotThreads: false },
        "channel-123": { requireMention: false, requireMentionInBotThreads: true },
      },
      accounts: { work: { requireMentionInBotThreads: true }, inherited: {} },
    });
    expect(result).toMatchObject({
      requireMentionInBotThreads: false,
      groups: {
        "*": { requireMention: true, requireMentionInBotThreads: false },
        "channel-123": { requireMention: false, requireMentionInBotThreads: true },
      },
      accounts: { work: { requireMentionInBotThreads: true } },
    });
    expect(result.accounts?.inherited).not.toHaveProperty("requireMentionInBotThreads");
  });
});
