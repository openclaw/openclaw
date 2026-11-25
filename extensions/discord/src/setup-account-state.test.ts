import type { DiscordAccountConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  inspectDiscordSetupAccount,
  resolveDiscordSetupAccountConfig,
} from "./setup-account-state.js";

const config = (discord: NonNullable<OpenClawConfig["channels"]>["discord"]): OpenClawConfig => ({
  channels: { discord },
});
const inspectToken = (token: DiscordAccountConfig["token"], rootToken?: string) =>
  inspectDiscordSetupAccount({
    cfg: config({ token: rootToken, accounts: { work: { token } } }),
    accountId: "work",
  });

describe("discord setup account state", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("resolves setup account config when account key casing differs from normalized id", () => {
    const resolved = resolveDiscordSetupAccountConfig({
      cfg: config({
        allowFrom: ["top"],
        accounts: { Work: { name: "Work", allowFrom: ["acct"] } },
      }),
      accountId: "work",
    });

    expect(resolved).toMatchObject({
      accountId: "work",
      config: { name: "Work", allowFrom: ["acct"] },
    });
  });

  it("uses configured defaultAccount for omitted setup account resolution", () => {
    const resolved = resolveDiscordSetupAccountConfig({
      cfg: config({
        defaultAccount: "work",
        allowFrom: ["top"],
        accounts: {
          alerts: { allowFrom: ["alerts-only"] },
          work: { name: "Work", allowFrom: ["work-only"] },
        },
      }),
    });
    expect(resolved).toMatchObject({
      accountId: "work",
      config: { name: "Work", allowFrom: ["work-only"] },
    });
  });

  it("treats explicit blank account tokens as missing without falling back", () => {
    expect(inspectToken("", "top-level-token")).toMatchObject({
      accountId: "work",
      token: "",
      tokenSource: "none",
      tokenStatus: "missing",
      configured: false,
    });
  });

  it("reports unresolved SecretRef account tokens as configured but unavailable", () => {
    expect(inspectToken({ source: "exec", provider: "vault", id: "discord/work" })).toMatchObject({
      token: "",
      tokenSource: "config",
      tokenStatus: "configured_unavailable",
      configured: true,
    });
  });

  it("keeps the runtime resolver's default-account-only environment fallback", () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "Bot setup-token");

    expect(inspectDiscordSetupAccount({ cfg: {}, accountId: "default" })).toMatchObject({
      token: "setup-token",
      tokenSource: "env",
      configured: true,
    });
    expect(
      inspectDiscordSetupAccount({
        cfg: config({ accounts: { work: {} } }),
        accountId: "work",
      }),
    ).toMatchObject({ token: "", tokenSource: "none", configured: false });
  });
});
