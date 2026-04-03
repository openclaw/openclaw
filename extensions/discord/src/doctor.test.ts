import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it } from "vitest";
import {
  collectDiscordNumericIdWarnings,
  maybeRepairDiscordNumericIds,
  scanDiscordNumericIdEntries,
} from "./doctor.js";

describe("discord doctor", () => {
  it("finds numeric id entries across discord scopes", () => {
    const cfg = {
      channels: {
        discord: {
          allowFrom: [123],
          dm: { allowFrom: ["ok"], groupChannels: [456] },
          execApprovals: { approvers: [789] },
          guilds: {
            main: {
              users: [111],
              roles: [222],
              channels: { general: { users: [333], roles: [444] } },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const hits = scanDiscordNumericIdEntries(cfg);
    expect(hits.map((hit) => hit.path)).toEqual([
      "channels.discord.allowFrom[0]",
      "channels.discord.dm.groupChannels[0]",
      "channels.discord.execApprovals.approvers[0]",
      "channels.discord.guilds.main.users[0]",
      "channels.discord.guilds.main.roles[0]",
      "channels.discord.guilds.main.channels.general.users[0]",
      "channels.discord.guilds.main.channels.general.roles[0]",
    ]);
  });

  it("repairs safe numeric ids into strings and warns for unsafe lists", () => {
    const cfg = {
      channels: {
        discord: {
          allowFrom: [123],
          dm: { allowFrom: [99] },
          guilds: { main: { users: [111], roles: [222] } },
        },
      },
    } as unknown as OpenClawConfig;

    const result = maybeRepairDiscordNumericIds(cfg, "openclaw doctor --fix");
    expect(result.config.channels?.discord?.allowFrom).toEqual(["123"]);
    expect(result.config.channels?.discord?.dm?.allowFrom).toEqual(["99"]);
    expect(result.config.channels?.discord?.guilds?.main?.users).toEqual(["111"]);
    expect(result.config.channels?.discord?.guilds?.main?.roles).toEqual(["222"]);
    expect(result.changes).not.toHaveLength(0);
    expect(result.warnings).toEqual([]);
  });

  it("formats repair guidance for unsafe numeric ids", () => {
    const warnings = collectDiscordNumericIdWarnings({
      hits: [{ path: "channels.discord.allowFrom[0]", entry: 106232522769186816, safe: false }],
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(warnings[0]).toContain("cannot be auto-repaired");
    expect(warnings[1]).toContain("openclaw doctor --fix");
  });
});
