// Discord tests cover access plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { createDiscordLivePolicyReader } from "../monitor/live-policy.js";
import { authorizeDiscordVoiceIngress } from "./access.js";

const ownerChannel = { users: ["discord:u-owner"] };
const expectedChannel = {
  allowed: true,
  requireMention: undefined,
  ignoreOtherMentions: undefined,
  skills: undefined,
  enabled: undefined,
  users: ownerChannel.users,
  roles: undefined,
  systemPrompt: undefined,
  includeThreadStarter: undefined,
  autoThread: undefined,
  autoThreadName: undefined,
  autoArchiveDuration: undefined,
  matchKey: "c1",
  matchSource: "direct",
};

function authorize(overrides: Partial<Parameters<typeof authorizeDiscordVoiceIngress>[0]> = {}) {
  return authorizeDiscordVoiceIngress({
    cfg: {},
    discordConfig: { guilds: { g1: { channels: { c1: ownerChannel } } } },
    groupPolicy: "allowlist",
    guildId: "g1",
    channelId: "c1",
    channelSlug: "",
    memberRoleIds: [],
    sender: { id: "u-owner", name: "owner" },
    ...overrides,
  });
}

describe("authorizeDiscordVoiceIngress", () => {
  it("applies published guild policy over retained voice startup settings", async () => {
    let cfg: OpenClawConfig = {
      channels: { discord: { groupPolicy: "allowlist", guilds: {} } },
    };
    const readPolicy = createDiscordLivePolicyReader({
      cfg,
      accountId: "default",
      token: "synthetic-token",
      readConfig: () => cfg,
    });
    const params = {
      readPolicy,
      cfg,
      discordConfig: {},
      accountId: "default",
      guildId: "111",
      channelId: "222",
      channelSlug: "",
      memberRoleIds: [],
      sender: { id: "333" },
    };
    expect((await authorizeDiscordVoiceIngress(params)).ok).toBe(false);
    cfg = {
      channels: {
        discord: {
          groupPolicy: "allowlist",
          guilds: { "111": { channels: { "222": { users: ["333"] } } } },
        },
      },
    };
    expect((await authorizeDiscordVoiceIngress(params)).ok).toBe(true);
    cfg = { channels: { discord: { groupPolicy: "disabled", guilds: {} } } };
    expect((await authorizeDiscordVoiceIngress(params)).ok).toBe(false);
  });

  it("blocks speakers outside the configured channel user allowlist", async () => {
    expect(await authorize({ sender: { id: "u-guest", name: "guest" } })).toEqual({
      ok: false,
      message: "You are not authorized to use this command.",
    });
  });

  it.each([
    { name: "direct guild and channel", guildKey: "g1", channelKey: "c1", guildName: undefined },
    { name: "slug-keyed guild", guildKey: "guild-one", channelKey: "*", guildName: "Guild One" },
    { name: "wildcard guild", guildKey: "*", channelKey: "*", guildName: undefined },
  ])(
    "allows matching speakers through $name configs",
    async ({ guildKey, channelKey, guildName }) => {
      const access = await authorize({
        discordConfig: { guilds: { [guildKey]: { channels: { [channelKey]: ownerChannel } } } },
        guildName,
      });
      expect(access).toEqual({
        ok: true,
        channelConfig: {
          ...expectedChannel,
          matchKey: channelKey,
          matchSource: channelKey === "*" ? "wildcard" : "direct",
        },
      });
    },
  );

  it("blocks commands when channel id is unavailable for an allowlisted channel", async () => {
    const access = await authorize({
      discordConfig: {
        guilds: { g1: { users: ownerChannel.users, channels: { c1: ownerChannel } } },
      },
      channelId: "",
    });
    expect(access).toEqual({
      ok: false,
      message: "This channel is not allowlisted for voice commands.",
    });
  });

  it("ignores dangerous name matching for voice ingress", async () => {
    const access = await authorize({
      discordConfig: {
        dangerouslyAllowNameMatching: true,
        guilds: { g1: { channels: { c1: { users: ["owner"] } } } },
      },
      sender: { id: "u-guest", name: "owner" },
    });
    expect(access).toEqual({
      ok: false,
      message: "You are not authorized to use this command.",
    });
  });

  it("uses resolved account command allowFrom over merged Discord config", async () => {
    const access = await authorize({
      discordConfig: { allowFrom: ["discord:u-root"], guilds: { g1: { channels: { c1: {} } } } },
      admissionAllowFrom: ["discord:u-account"],
      sender: { id: "u-account", name: "owner" },
    });
    expect(access).toEqual({
      ok: true,
      channelConfig: { ...expectedChannel, users: undefined },
    });
  });
});
