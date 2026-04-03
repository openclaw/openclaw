import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it } from "vitest";
import { discordSetupWizard } from "./setup-surface.js";

describe("discordSetupWizard.dmPolicy", () => {
  it("reads the named-account DM policy instead of the channel root", () => {
    expect(
      discordSetupWizard.dmPolicy?.getCurrent(
        {
          channels: {
            discord: {
              dmPolicy: "disabled",
              accounts: {
                alerts: {
                  dmPolicy: "allowlist",
                  token: "discord-token",
                },
              },
            },
          },
        } as OpenClawConfig,
        "alerts",
      ),
    ).toBe("allowlist");
  });

  it("reports account-scoped config keys for named accounts", () => {
    expect(discordSetupWizard.dmPolicy?.resolveConfigKeys?.({}, "alerts")).toEqual({
      policyKey: "channels.discord.accounts.alerts.dmPolicy",
      allowFromKey: "channels.discord.accounts.alerts.allowFrom",
    });
  });

  it('writes open policy state to the named account and preserves inherited allowFrom with "*"', () => {
    const next = discordSetupWizard.dmPolicy?.setPolicy(
      {
        channels: {
          discord: {
            allowFrom: ["123"],
            accounts: {
              alerts: {
                token: "discord-token",
              },
            },
          },
        },
      } as OpenClawConfig,
      "open",
      "alerts",
    );

    expect(next?.channels?.discord?.dmPolicy).toBeUndefined();
    expect(next?.channels?.discord?.accounts?.alerts?.dmPolicy).toBe("open");
    expect(next?.channels?.discord?.accounts?.alerts?.allowFrom).toEqual(["123", "*"]);
  });
});
