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

  it.each([
    ["case-insensitive key", "work", undefined, "Work"],
    ["configured defaultAccount", undefined, "work", "work"],
  ] as const)(
    "resolves the %s and its account overrides",
    (_name, accountId, defaultAccount, key) => {
      expect(
        resolveDiscordSetupAccountConfig({
          cfg: config({
            defaultAccount,
            allowFrom: ["top"],
            accounts: {
              alerts: { allowFrom: ["alerts-only"] },
              [key]: { name: "Work", allowFrom: ["acct"] },
            },
          }),
          accountId,
        }),
      ).toMatchObject({ accountId: "work", config: { name: "Work", allowFrom: ["acct"] } });
    },
  );

  it.each([
    ["blank", "", "none", "missing", false],
    [
      "unresolved SecretRef",
      { source: "exec", provider: "vault", id: "discord/work" },
      "config",
      "configured_unavailable",
      true,
    ],
  ] as const)(
    "reports %s account tokens without falling back",
    (_name, token, tokenSource, tokenStatus, configured) => {
      expect(inspectToken(token, "top-level-token")).toMatchObject({
        accountId: "work",
        token: "",
        tokenSource,
        tokenStatus,
        configured,
      });
    },
  );

  it("keeps the runtime resolver's default-account-only environment fallback", () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "Bot setup-token");

    expect(inspectDiscordSetupAccount({ cfg: {}, accountId: "default" })).toMatchObject({
      token: "setup-token",
      tokenSource: "env",
      configured: true,
    });
    expect(
      inspectDiscordSetupAccount({ cfg: config({ accounts: { work: {} } }), accountId: "work" }),
    ).toMatchObject({ token: "", tokenSource: "none", configured: false });
  });
});
