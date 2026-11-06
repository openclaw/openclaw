import { installChannelDmPolicyContractSuite } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { discordSetupWizard } from "./setup-core.js";

const config = (discord: NonNullable<OpenClawConfig["channels"]>["discord"]): OpenClawConfig => ({
  channels: { discord },
});

describe("discordSetupWizard.dmPolicy", () => {
  installChannelDmPolicyContractSuite({
    dmPolicy: discordSetupWizard.dmPolicy!,
    cases: [
      {
        name: "Discord named accounts",
        channel: "discord",
        accountId: "alerts",
        accountConfig: { token: "discord-token" },
        inheritedAllowFrom: ["123"],
      },
    ],
  });
});

describe("discordSetupWizard.status", () => {
  it("uses configured defaultAccount for omitted setup configured state", async () => {
    const configured = await discordSetupWizard.status.resolveConfigured({
      cfg: config({
        defaultAccount: "work",
        token: "discord-root-token",
        accounts: {
          alerts: { token: "discord-alerts-token" },
          work: { token: "" },
        },
      }),
    });

    expect(configured).toBe(false);
  });
});

describe("discordSetupWizard.groupAccess", () => {
  it("writes resolved Discord channel rows to their selected guild and channel", () => {
    const next = discordSetupWizard.groupAccess?.applyAllowlist?.({
      cfg: config({ guilds: { existing: { channels: { keep: { enabled: true } } } } }),
      accountId: "default",
      resolved: [
        {
          input: "OpenClaw/#triage",
          resolved: true,
          guildId: "guild-1",
          channelId: "channel-1",
        },
        { input: "missing", resolved: false },
      ],
    });

    const guilds = next?.channels?.discord?.guilds;
    expect(guilds?.["guild-1"]?.channels?.["channel-1"]).toEqual({ enabled: true });
    expect(guilds?.["*"]).toBeUndefined();
    expect(guilds?.existing?.channels?.keep).toEqual({ enabled: true });
  });
});
