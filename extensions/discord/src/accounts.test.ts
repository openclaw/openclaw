import type {
  DiscordAccountConfig,
  DiscordConfig,
  OpenClawConfig,
} from "openclaw/plugin-sdk/config-contracts";
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

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Discord defaultAccount omission contract", () => {
  it("createDiscordActionGate uses configured defaultAccount when accountId is omitted", () => {
    const gate = createDiscordActionGate({
      cfg: {
        channels: {
          discord: {
            actions: { reactions: false },
            defaultAccount: "work",
            accounts: { work: { token: "token-work", actions: { reactions: true } } },
          },
        },
      },
    });

    expect(gate("reactions")).toBe(true);
  });

  it("keeps the implicit default account when named accounts are added to top-level credentials", () => {
    const cfg = {
      channels: {
        discord: {
          token: "token-default",
          accounts: { work: { enabled: false, token: "token-work" } },
        },
      },
    } as OpenClawConfig;

    expect(listDiscordAccountIds(cfg)).toEqual(["default", "work"]);
    expect(resolveDefaultDiscordAccountId(cfg)).toBe("default");
    expect(listEnabledDiscordAccounts(cfg).map((account) => account.accountId)).toEqual([
      "default",
    ]);
  });
});

describe("resolveDiscordAccount allowFrom precedence", () => {
  it("does not inherit default account allowFrom for named account when top-level is absent", () => {
    const resolved = resolveDiscordAccount({
      cfg: {
        channels: {
          discord: {
            accounts: {
              default: { allowFrom: ["default"], token: "token-default" },
              work: { token: "token-work" },
            },
          },
        },
      },
      accountId: "work",
    });

    expect(resolved.config.allowFrom).toBeUndefined();
  });
});

describe("resolveDiscordMaxLinesPerMessage", () => {
  it.each<{
    name: string;
    accounts: Record<string, DiscordAccountConfig>;
    discordConfig: Pick<DiscordConfig, "maxLinesPerMessage">;
    accountId: string;
    expected: number;
  }>([
    {
      name: "prefers explicit runtime discord maxLinesPerMessage over merged config",
      accounts: { default: { token: "token-default", maxLinesPerMessage: 80 } },
      discordConfig: { maxLinesPerMessage: 55 },
      accountId: "default",
      expected: 55,
    },
    {
      name: "uses per-account discord maxLinesPerMessage over the root value when runtime config omits it",
      accounts: { work: { token: "token-work", maxLinesPerMessage: 80 } },
      discordConfig: {},
      accountId: "work",
      expected: 80,
    },
  ])("$name", ({ accounts, discordConfig, accountId, expected }) => {
    const resolved = resolveDiscordMaxLinesPerMessage({
      cfg: { channels: { discord: { maxLinesPerMessage: 120, accounts } } },
      discordConfig,
      accountId,
    });

    expect(resolved).toBe(expected);
  });
});

describe("Discord duplicate-token account filtering", () => {
  it("keeps the config-token account over default env fallback when tokens collide", () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "same-token");
    const accountId = "work";
    const duplicateId = "default";
    const expectedReason = 'duplicate bot token; using account "work"';
    const cfg = { channels: { discord: { accounts: { work: { token: "same-token" } } } } };
    const enabledAccount = resolveDiscordAccount({ cfg, accountId });
    const duplicateAccount = resolveDiscordAccount({ cfg, accountId: duplicateId });

    expect(isDiscordAccountEnabledForRuntime(duplicateAccount, cfg)).toBe(false);
    expect(resolveDiscordAccountDisabledReason(duplicateAccount, cfg)).toBe(expectedReason);
    expect(inspectDiscordAccount({ cfg, accountId: duplicateId })).toMatchObject({
      enabled: false,
      configured: true,
      stateReason: expectedReason,
    });
    expect(inspectDiscordAccount({ cfg, accountId })).toMatchObject({
      enabled: true,
      configured: true,
    });
    expect(isDiscordAccountEnabledForRuntime(enabledAccount, cfg)).toBe(true);
    expect(listEnabledDiscordAccounts(cfg).map((account) => account.accountId)).toEqual([
      accountId,
    ]);
  });

  it("does not let disabled duplicate-token accounts suppress enabled accounts", () => {
    const cfg = {
      channels: {
        discord: {
          accounts: {
            disabled: { enabled: false, token: "same-token" },
            active: { token: "same-token" },
          },
        },
      },
    };

    const activeAccount = resolveDiscordAccount({ cfg, accountId: "active" });

    expect(isDiscordAccountEnabledForRuntime(activeAccount, cfg)).toBe(true);
    expect(inspectDiscordAccount({ cfg, accountId: "active" }).enabled).toBe(true);
    expect(inspectDiscordAccount({ cfg, accountId: "disabled" })).toMatchObject({
      enabled: false,
      stateReason: "disabled",
    });
    expect(listEnabledDiscordAccounts(cfg).map((account) => account.accountId)).toEqual(["active"]);
  });
});
