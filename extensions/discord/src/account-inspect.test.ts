import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { inspectDiscordAccount } from "./account-inspect.js";

function inspectWorkAccount(discord: unknown) {
  return inspectDiscordAccount({
    cfg: { channels: { discord } } as OpenClawConfig,
    accountId: "work",
  });
}

describe("inspectDiscordAccount", () => {
  it.each([
    [
      "prefers account token and strips Bot prefix",
      { token: "Bot channel-token", accounts: { work: { token: "Bot account-token" } } },
      { token: "account-token", tokenSource: "config", tokenStatus: "available", configured: true },
    ],
    [
      "reports unresolved configured secret input",
      { accounts: { work: { token: { source: "env", id: "DISCORD_TOKEN" } } } },
      {
        token: "",
        tokenSource: "config",
        tokenStatus: "configured_unavailable",
        enabled: true,
        configured: true,
      },
    ],
    [
      "does not fall back for an empty account token",
      { token: "Bot channel-token", accounts: { work: { token: "" } } },
      { token: "", tokenSource: "none", tokenStatus: "missing", enabled: true, configured: false },
    ],
    [
      "falls back when account token is absent",
      { token: "Bot channel-token", accounts: { work: {} } },
      { token: "channel-token", tokenSource: "config", tokenStatus: "available", configured: true },
    ],
  ] as const)("%s", (_name, discord, expected) => {
    expect(inspectWorkAccount(discord)).toMatchObject(expected);
  });

  it("allows env token only for default account", () => {
    const defaultInspected = inspectDiscordAccount({
      cfg: {},
      accountId: "default",
      envToken: "Bot env-default",
    });
    const namedInspected = inspectDiscordAccount({
      cfg: { channels: { discord: { accounts: { work: {} } } } },
      accountId: "work",
      envToken: "Bot env-work",
    });

    expect(defaultInspected).toMatchObject({
      token: "env-default",
      tokenSource: "env",
      configured: true,
    });
    expect(namedInspected).toMatchObject({ token: "", tokenSource: "none", configured: false });
  });
});
