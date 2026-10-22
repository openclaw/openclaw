import type { DiscordConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectDiscordAccount } from "./account-inspect.js";
import {
  createDiscordActionGate,
  isDiscordAccountEnabledForRuntime,
  listDiscordAccountIds,
  listEnabledDiscordAccounts,
  resolveDefaultDiscordAccountId,
  resolveDiscordAccount,
  resolveDiscordAccountDisabledReason,
  resolveDiscordMaxLinesPerMessage,
} from "./accounts.js";

afterEach(() => vi.unstubAllEnvs());

function config(discord: DiscordConfig): OpenClawConfig {
  return { channels: { discord } };
}
const enabledIds = (cfg: OpenClawConfig) => listEnabledDiscordAccounts(cfg).map((a) => a.accountId);

describe("Discord accounts", () => {
  it("createDiscordActionGate uses configured defaultAccount when accountId is omitted", () => {
    const gate = createDiscordActionGate({
      cfg: config({
        actions: { reactions: false },
        defaultAccount: "work",
        accounts: { work: { token: "token-work", actions: { reactions: true } } },
      }),
    });

    expect(gate("reactions")).toBe(true);
  });

  it("keeps the implicit default account when named accounts are added to top-level credentials", () => {
    const cfg = config({
      token: "token-default",
      accounts: { work: { enabled: false, token: "token-work" } },
    });

    expect(listDiscordAccountIds(cfg)).toEqual(["default", "work"]);
    expect(resolveDefaultDiscordAccountId(cfg)).toBe("default");
    expect(enabledIds(cfg)).toEqual(["default"]);
  });
  it("does not inherit default account allowFrom for named account when top-level is absent", () => {
    const cfg = config({
      accounts: {
        default: { allowFrom: ["default"], token: "token-default" },
        work: { token: "token-work" },
      },
    });
    expect(resolveDiscordAccount({ cfg, accountId: "work" }).config.allowFrom).toBeUndefined();
  });
  it.each([
    ["prefers explicit runtime over merged config", "default", { maxLinesPerMessage: 55 }, 55],
    ["uses per-account value over root when runtime omits it", "work", {}, 80],
  ] as const)("maxLinesPerMessage %s", (_name, accountId, discordConfig, expected) => {
    expect(
      resolveDiscordMaxLinesPerMessage({
        cfg: config({
          maxLinesPerMessage: 120,
          accounts: { [accountId]: { token: `token-${accountId}`, maxLinesPerMessage: 80 } },
        }),
        discordConfig,
        accountId,
      }),
    ).toBe(expected);
  });
  it.each([
    {
      name: "prefers config token over default env fallback",
      cfg: config({ accounts: { work: { token: "same-token" } } }),
      active: "work",
      inactive: "default",
      reason: 'duplicate bot token; using account "work"',
      env: "same-token",
    },
    {
      name: "ignores disabled duplicate-token accounts",
      cfg: config({
        accounts: {
          disabled: { enabled: false, token: "same-token" },
          active: { token: "same-token" },
        },
      }),
      active: "active",
      inactive: "disabled",
      reason: "disabled",
      env: "",
    },
  ])("$name", ({ cfg, active, inactive, reason, env }) => {
    vi.stubEnv("DISCORD_BOT_TOKEN", env);
    const activeAccount = resolveDiscordAccount({ cfg, accountId: active });
    const inactiveAccount = resolveDiscordAccount({ cfg, accountId: inactive });
    expect(isDiscordAccountEnabledForRuntime(activeAccount, cfg)).toBe(true);
    expect(isDiscordAccountEnabledForRuntime(inactiveAccount, cfg)).toBe(false);
    expect(resolveDiscordAccountDisabledReason(inactiveAccount, cfg)).toBe(reason);
    expect(inspectDiscordAccount({ cfg, accountId: active })).toMatchObject({
      enabled: true,
      configured: true,
    });
    expect(inspectDiscordAccount({ cfg, accountId: inactive })).toMatchObject({
      enabled: false,
      configured: true,
      stateReason: reason,
    });
    expect(enabledIds(cfg)).toEqual([active]);
  });
});
