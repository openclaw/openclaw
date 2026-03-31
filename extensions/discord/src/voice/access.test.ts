import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { DiscordAccountConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it } from "vitest";
import { authorizeDiscordVoiceIngress } from "./access.js";

const baseCfg = { commands: { useAccessGroups: true } } as OpenClawConfig;

describe("authorizeDiscordVoiceIngress", () => {
  it("blocks speakers outside the configured channel user allowlist", async () => {
    const access = await authorizeDiscordVoiceIngress({
      cfg: baseCfg,
      discordConfig: {
        guilds: {
          g1: {
            channels: {
              c1: {
                users: ["discord:u-owner"],
              },
            },
          },
        },
      } as DiscordAccountConfig,
      groupPolicy: "allowlist",
      guildId: "g1",
      channelId: "c1",
      channelSlug: "",
      memberRoleIds: [],
      sender: {
        id: "u-guest",
        name: "guest",
      },
    });

    expect(access).toEqual({
      ok: false,
      message: "You are not authorized to use this command.",
    });
  });

  it("allows speakers that match the configured channel user allowlist", async () => {
    const access = await authorizeDiscordVoiceIngress({
      cfg: baseCfg,
      discordConfig: {
        guilds: {
          g1: {
            channels: {
              c1: {
                users: ["discord:u-owner"],
              },
            },
          },
        },
      } as DiscordAccountConfig,
      groupPolicy: "allowlist",
      guildId: "g1",
      channelId: "c1",
      channelSlug: "",
      memberRoleIds: [],
      sender: {
        id: "u-owner",
        name: "owner",
      },
    });

    expect(access).toEqual({ ok: true });
  });

  it("allows slug-keyed guild configs when manager context only has guild name", async () => {
    const access = await authorizeDiscordVoiceIngress({
      cfg: baseCfg,
      discordConfig: {
        guilds: {
          "guild-one": {
            channels: {
              "*": {
                users: ["discord:u-owner"],
              },
            },
          },
        },
      } as DiscordAccountConfig,
      groupPolicy: "allowlist",
      guildId: "g1",
      guildName: "Guild One",
      channelId: "c1",
      channelSlug: "",
      memberRoleIds: [],
      sender: {
        id: "u-owner",
        name: "owner",
      },
    });

    expect(access).toEqual({ ok: true });
  });

  it("does not block commands when channel id is unavailable", async () => {
    const access = await authorizeDiscordVoiceIngress({
      cfg: baseCfg,
      discordConfig: {
        guilds: {
          g1: {
            users: ["discord:u-owner"],
            channels: {
              c1: {
                users: ["discord:u-owner"],
              },
            },
          },
        },
      } as DiscordAccountConfig,
      groupPolicy: "allowlist",
      guildId: "g1",
      channelId: "",
      channelSlug: "",
      memberRoleIds: [],
      sender: {
        id: "u-owner",
        name: "owner",
      },
    });

    expect(access).toEqual({ ok: true });
  });
});
