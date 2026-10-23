import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import {
  collectDiscordMissingEnvTokenWarnings,
  collectDiscordNumericIdWarnings,
  discordDoctor,
  maybeRepairDiscordNumericIds,
  scanDiscordNumericIdEntries,
} from "./doctor.js";

function discordConfig(discord: Record<string, unknown>): OpenClawConfig {
  return { channels: { discord } } as OpenClawConfig;
}

function normalize(discord: Record<string, unknown>) {
  const normalizeConfig = discordDoctor.normalizeCompatibilityConfig;
  if (!normalizeConfig) {
    throw new Error("Expected discord compatibility normalizer");
  }
  return normalizeConfig({ cfg: discordConfig(discord) });
}

const realtime = (wakeNames: string[]) => ({ voice: { realtime: { wakeNames } } });

describe("discord doctor", () => {
  it("strips retired gateway, queue, and retry tuning at root and account scope", () => {
    const providers = { custom: { retry: { attempts: 9 }, eventQueue: { maxConcurrency: 2 } } };
    const result = normalize({
      gatewayInfoTimeoutMs: 1,
      gatewayReadyTimeoutMs: 2,
      gatewayRuntimeReadyTimeoutMs: 3,
      eventQueue: { listenerTimeout: 4 },
      retry: { attempts: 5 },
      voice: { realtime: { providers: structuredClone(providers) } },
      accounts: {
        work: { eventQueue: { maxConcurrency: 6 }, retry: { attempts: 7 } },
      },
    });

    expect(result.config.channels?.discord).toEqual({
      voice: { realtime: { providers } },
      accounts: { work: {} },
    });
    expect(result.changes).toContain("Removed retired Discord tuning knobs.");
  });

  it.each([undefined, "progress"] as const)(
    "migrates delivery aliases without inventing preview mode (legacy mode=%s)",
    (mode) => {
      const result = normalize({ blockStreaming: true, ...(mode ? { streamMode: mode } : {}) });
      const discord = result.config.channels?.discord as Record<string, unknown>;
      expect(discord).toEqual({
        streaming: { ...(mode ? { mode } : {}), block: { enabled: true } },
      });
      expect(result.changes).toEqual([
        ...(mode
          ? ["Moved channels.discord.streamMode → channels.discord.streaming.mode (progress)."]
          : []),
        "Moved channels.discord.blockStreaming → channels.discord.streaming.block.enabled.",
      ]);
    },
  );

  it("seeds the inherited root streaming settings when migrating account delivery aliases", () => {
    // Account `streaming` objects replace the root object wholesale on merge,
    // so the migrated account must carry the settings it previously inherited.
    const result = normalize({
      streaming: { mode: "off", block: { coalesce: { idleMs: 5 } } },
      accounts: { work: { chunkMode: "newline" } },
    });

    expect(result.config.channels?.discord).toEqual({
      streaming: { mode: "off", block: { coalesce: { idleMs: 5 } } },
      accounts: {
        work: {
          streaming: {
            mode: "off",
            chunkMode: "newline",
            block: { coalesce: { idleMs: 5 } },
          },
        },
      },
    });
    expect(result.changes).toEqual([
      "Moved channels.discord.accounts.work.chunkMode → channels.discord.accounts.work.streaming.chunkMode.",
      "Copied channels.discord.streaming into channels.discord.accounts.work.streaming to keep inherited settings while migrating flat streaming keys.",
    ]);
  });

  it("preserves supported provider maps and channel bindings", () => {
    const cfg: OpenClawConfig = {
      channels: {
        discord: {
          voice: { tts: { providers: { openai: { voice: "alloy" } } } },
          guilds: { agentId: { channels: { allow: { enabled: false } } } },
        },
      },
      bindings: [{ agentId: "main", match: { channel: "discord" } }],
    };
    expect(discordDoctor.normalizeCompatibilityConfig?.({ cfg })).toEqual({
      config: cfg,
      changes: [],
    });
  });

  it("removes unsupported Discord realtime wake names", () => {
    const result = normalize({
      ...realtime(["Claw", "Claw Bot Helper", "Open Claw"]),
      accounts: {
        work: realtime(["Work Bot Helper", "Work Bot"]),
        invalid: realtime(["Only Three Words"]),
        empty: realtime([]),
      },
    });

    expect(result.changes).toEqual([
      "Shortened 1 unsupported channels.discord.accounts.work.voice.realtime.wakeNames entries to one or two words.",
      "Shortened 1 unsupported channels.discord.accounts.invalid.voice.realtime.wakeNames entries to one or two words.",
      "Removed empty channels.discord.accounts.empty.voice.realtime.wakeNames; unset wake names use the default agent/OpenClaw fallback.",
      "Shortened 1 unsupported channels.discord.voice.realtime.wakeNames entries to one or two words.",
    ]);
    const discord = result.config.channels?.discord;
    expect([
      discord?.voice?.realtime?.wakeNames,
      discord?.accounts?.work?.voice?.realtime?.wakeNames,
      discord?.accounts?.invalid?.voice?.realtime?.wakeNames,
      discord?.accounts?.empty?.voice?.realtime?.wakeNames,
    ]).toEqual([["Claw", "Claw Bot", "Open Claw"], ["Work Bot"], ["Only Three"], undefined]);
  });

  it("finds numeric id entries across discord scopes", () => {
    const cfg = discordConfig({
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
    });

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
    const cfg = discordConfig({
      allowFrom: [123],
      dm: { allowFrom: [99] },
      guilds: { main: { users: [111], roles: [222] } },
    });

    const result = maybeRepairDiscordNumericIds(cfg, "openclaw doctor --fix");
    expect(result.config.channels?.discord).toMatchObject({
      allowFrom: ["123"],
      dm: { allowFrom: ["99"] },
      guilds: { main: { users: ["111"], roles: ["222"] } },
    });
    expect(result.changes).not.toHaveLength(0);
    expect(result.warnings).toStrictEqual([]);
  });

  it("formats repair guidance for unsafe numeric ids", () => {
    const warnings = collectDiscordNumericIdWarnings({
      hits: [{ path: "channels.discord.allowFrom[0]", entry: 106232522769186816, safe: false }],
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(warnings[0]).toContain("cannot be auto-repaired");
    expect(warnings[1]).toContain("openclaw doctor --fix");
  });

  it("recommends the supported name-matching config key", async () => {
    const warnings = await discordDoctor.collectMutableAllowlistWarnings?.({
      cfg: { channels: { discord: { allowFrom: ["alice"] } } },
    });
    expect(warnings?.join("\n")).toContain("channels.discord.dangerouslyAllowNameMatching=true");
  });

  it("warns when default env fallback token is missing after migration", async () => {
    const cfg = discordConfig({ allowFrom: ["123"] });

    const missingTokenWarning =
      "- channels.discord: default account has no available bot token, and DISCORD_BOT_TOKEN is absent in this doctor environment. After migration, verify DISCORD_BOT_TOKEN is present in the state-dir .env or configure channels.discord.token / channels.discord.accounts.default.token as a SecretRef.";
    expect(collectDiscordMissingEnvTokenWarnings({ cfg, env: {} })).toStrictEqual([
      missingTokenWarning,
    ]);
    expect(
      collectDiscordMissingEnvTokenWarnings({ cfg, env: { DISCORD_BOT_TOKEN: "Bot tok" } }),
    ).toStrictEqual([]);
    expect(
      await discordDoctor.collectPreviewWarnings?.({
        cfg,
        doctorFixCommand: "openclaw doctor --fix",
        env: {},
      }),
    ).toStrictEqual([missingTokenWarning]);
  });

  it("warns when Discord transcript auto-start cannot choose between voice accounts", async () => {
    const cfg = {
      transcripts: {
        autoStart: [
          { providerId: "discord-voice", guildId: "guild-1", channelId: "channel-1" },
          {
            providerId: "discord-voice",
            accountId: "alpha",
            guildId: "guild-1",
            channelId: "channel-2",
          },
          { providerId: "meeting", meetingUrl: "https://meet.example.test/standup" },
        ],
      },
      channels: {
        discord: {
          accounts: {
            alpha: { token: "alpha-token", voice: { enabled: true } },
            bravo: { token: "bravo-token", voice: { enabled: true } },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const warnings =
      (await discordDoctor.collectPreviewWarnings?.({
        cfg,
        doctorFixCommand: "openclaw doctor --fix",
        env: {},
      })) ?? [];

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("transcripts.autoStart[0]");
    expect(warnings[0]).toContain("Multiple Discord accounts are enabled for voice");
    expect(warnings[0]).toContain("transcripts.autoStart[0].accountId");
    expect(warnings[0]).toContain("channels.discord.defaultAccount");
  });
});
