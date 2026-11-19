import { expectDirectoryIds } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import {
  listDiscordDirectoryGroupsFromConfig,
  listDiscordDirectoryPeersFromConfig,
} from "../directory-contract-api.js";

function config(discord: NonNullable<OpenClawConfig["channels"]>["discord"]): OpenClawConfig {
  return { channels: { discord } };
}

describe("Discord directory contract", () => {
  it("lists peers/groups from config (numeric ids only)", async () => {
    const cfg = config({
      token: "discord-test",
      allowFrom: ["<@111>", "<@!333>", "nope"],
      dms: { "222": {} },
      guilds: {
        "123": {
          users: ["<@12345>", " discord:444 ", "not-an-id"],
          channels: {
            "555": {},
            "<#777>": {},
            "channel:666": {},
            general: {},
          },
        },
      },
    });

    await expectDirectoryIds(
      listDiscordDirectoryPeersFromConfig,
      cfg,
      ["user:111", "user:12345", "user:222", "user:333", "user:444"],
      { sorted: true },
    );
    await expectDirectoryIds(
      listDiscordDirectoryGroupsFromConfig,
      cfg,
      ["channel:555", "channel:666", "channel:777"],
      { sorted: true },
    );
  });

  it("keeps directories readable when tokens are unresolved SecretRefs", async () => {
    const cfg = config({
      token: { source: "env", provider: "default", id: "MISSING_TEST_SECRET" },
      allowFrom: ["<@111>"],
      guilds: { "123": { channels: { "555": {} } } },
    });

    await expectDirectoryIds(listDiscordDirectoryPeersFromConfig, cfg, ["user:111"]);
    await expectDirectoryIds(listDiscordDirectoryGroupsFromConfig, cfg, ["channel:555"]);
  });

  it("uses account allowFrom before inherited root allowFrom", async () => {
    const cfg = config({
      allowFrom: ["<@111>"],
      accounts: { work: { allowFrom: ["<@222>"] } },
    });

    const entries = await listDiscordDirectoryPeersFromConfig({
      cfg,
      accountId: "work",
      query: null,
      limit: null,
    });
    expect(entries.map((entry) => entry.id)).toEqual(["user:222"]);
  });

  it("applies query and limit filtering for config-backed directories", async () => {
    const cfg = config({
      token: "discord-test",
      guilds: { "123": { channels: { "555": {}, "666": {}, "777": {} } } },
    });

    const groups = await listDiscordDirectoryGroupsFromConfig({
      cfg,
      accountId: "default",
      query: "666",
      limit: 5,
    });
    expect(groups.map((entry) => entry.id)).toEqual(["channel:666"]);
  });
});
