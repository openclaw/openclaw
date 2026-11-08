import type { DiscordAccountConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { createDiscordLivePolicyReader } from "../monitor/live-policy.js";
import { authorizeDiscordVoiceIngress } from "./access.js";

const ownerChannel = { users: ["discord:u-owner"] };
const expectedChannel = {
  allowed: true,
  users: ownerChannel.users,
  matchKey: "c1",
  matchSource: "direct",
};
const config = (discord: DiscordAccountConfig): OpenClawConfig => ({ channels: { discord } });

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
    let cfg = config({ groupPolicy: "allowlist", guilds: {} });
    const readPolicy = createDiscordLivePolicyReader({
      cfg,
      accountId: "default",
      token: "synthetic-token",
      readConfig: () => cfg,
    });
    const params = { readPolicy, cfg, discordConfig: {}, sender: { id: "333" } };
    const check = () => authorize(params);
    expect((await check()).ok).toBe(false);
    const guilds = { g1: { channels: { c1: { users: ["333"] } } } };
    cfg = config({ groupPolicy: "allowlist", guilds });
    expect((await check()).ok).toBe(true);
    cfg = config({ groupPolicy: "disabled", guilds: {} });
    expect((await check()).ok).toBe(false);
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

  it.each([
    { name: "unlisted speaker", overrides: { sender: { id: "u-guest", name: "guest" } } },
    {
      name: "missing channel id",
      overrides: {
        discordConfig: {
          guilds: { g1: { users: ownerChannel.users, channels: { c1: ownerChannel } } },
        },
        channelId: "",
      },
      message: "This channel is not allowlisted for voice commands.",
    },
    {
      name: "dangerous name matching",
      overrides: {
        discordConfig: {
          dangerouslyAllowNameMatching: true,
          guilds: { g1: { channels: { c1: { users: ["owner"] } } } },
        },
        sender: { id: "u-guest", name: "owner" },
      },
    },
  ])("rejects $name", async ({ overrides, message }) => {
    expect(await authorize(overrides)).toEqual({
      ok: false,
      message: message ?? "You are not authorized to use this command.",
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
