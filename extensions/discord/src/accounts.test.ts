import type { DiscordConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
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
import {
  getDiscordExecApprovalApprovers as approvers,
  isDiscordExecApprovalApprover as isApprover,
  isDiscordExecApprovalClientEnabled as approvalsEnabled,
} from "./exec-approvals.js";
import { resolveDiscordToken } from "./token.js";

afterEach(() => {
  clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
});

function config(discord: DiscordConfig = {}, owners?: string[]): OpenClawConfig {
  return { channels: { discord }, ...(owners ? { commands: { ownerAllowFrom: owners } } : {}) };
}
const secret = (id: string) => ({ source: "env" as const, provider: "default", id });
const enabledIds = (cfg: OpenClawConfig) => listEnabledDiscordAccounts(cfg).map((a) => a.accountId);
const inspect = (cfg: OpenClawConfig, ...ids: string[]) =>
  ids.map((accountId) => inspectDiscordAccount({ cfg, accountId }));
const workConfig = (
  work: NonNullable<DiscordConfig["accounts"]>[string],
  root: DiscordConfig = {},
) => config({ ...root, accounts: { work } });

describe("Discord accounts", () => {
  it("createDiscordActionGate uses configured defaultAccount when accountId is omitted", () => {
    const cfg = workConfig(
      { actions: { reactions: true } },
      {
        actions: { reactions: false },
        defaultAccount: "work",
      },
    );
    expect(createDiscordActionGate({ cfg })("reactions")).toBe(true);
  });

  it("keeps the implicit default account when named accounts are added to top-level credentials", () => {
    const cfg = workConfig({ enabled: false, token: "work" }, { token: "default" });

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
  it("ignores disabled duplicate-token accounts", () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "same-token");
    const cfg = config({
      accounts: {
        disabled: { enabled: false, token: "same-token" },
        active: { token: "same-token" },
      },
    });
    const activeAccount = resolveDiscordAccount({ cfg, accountId: "active" });
    const inactiveAccount = resolveDiscordAccount({ cfg, accountId: "disabled" });
    expect(isDiscordAccountEnabledForRuntime(activeAccount, cfg)).toBe(true);
    expect(isDiscordAccountEnabledForRuntime(inactiveAccount, cfg)).toBe(false);
    expect(resolveDiscordAccountDisabledReason(inactiveAccount, cfg)).toBe("disabled");
    expect(inspect(cfg, "active", "disabled", "default")).toMatchObject([
      { enabled: true, configured: true },
      { enabled: false, configured: true, stateReason: "disabled" },
      {
        enabled: false,
        configured: true,
        stateReason: 'duplicate bot token; using account "active"',
      },
    ]);
    expect(enabledIds(cfg)).toEqual(["active"]);
  });
});

describe("resolveDiscordToken", () => {
  const missing = { token: "", source: "none", tokenStatus: "missing" };
  const unavailable = { token: "", source: "config", tokenStatus: "configured_unavailable" };
  it.each([
    ["blank account", "", "work", missing],
    ["root SecretRef", secret("DISCORD_BOT_TOKEN"), undefined, unavailable],
    ["account SecretRef", secret("DISCORD_WORK_TOKEN"), "work", unavailable],
  ] as const)("blocks fallback for %s", (_name, token, accountId, expected) => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "env-token");
    const cfg = config(
      accountId ? { token: "base-token", accounts: { work: { token } } } : { token },
    );
    expect(resolveDiscordToken(cfg, { accountId })).toEqual(expected);
  });

  it("uses the active runtime snapshot when resolving a matching source config", () => {
    const source = workConfig({ token: secret("DISCORD_WORK_TOKEN") });
    setRuntimeConfigSnapshot(workConfig({ token: "Bot runtime-work-token" }), source);
    expect(resolveDiscordToken(source, { accountId: "work" })).toEqual({
      token: "runtime-work-token",
      source: "config",
      tokenStatus: "available",
    });
  });
});

describe("discord exec approvals", () => {
  const approvalConfig = (
    execApprovals?: DiscordConfig["execApprovals"],
    owners?: string[],
    allowFrom?: string[],
  ) => ({
    cfg: config(
      { execApprovals, ...(allowFrom ? { allowFrom, defaultTo: "user:789" } : {}) },
      owners,
    ),
  });

  it.each<[DiscordConfig["execApprovals"], string[] | undefined, boolean]>([
    [undefined, undefined, false],
    [{ enabled: true }, undefined, false],
    [{ approvers: ["123"] }, undefined, false],
    [undefined, ["discord:789"], false],
    [{ enabled: "auto", approvers: ["123"] }, undefined, true],
    [{ enabled: false, approvers: ["123"] }, undefined, false],
  ])("requires explicit enablement and resolved owners (%j)", (settings, owners, expected) => {
    expect(approvalsEnabled(approvalConfig(settings, owners))).toBe(expected);
  });

  it("prefers explicit approvers over allowFrom and default routes", () => {
    const ctx = approvalConfig({ approvers: ["456"] }, undefined, ["123"]);
    expect(approvers(ctx)).toEqual(["456"]);
    expect([
      isApprover({ ...ctx, senderId: "456" }),
      isApprover({ ...ctx, senderId: "123" }),
    ]).toEqual([true, false]);
  });

  it("does not infer approvers from allowFrom or default DM routes", () => {
    const ctx = approvalConfig({ enabled: true }, undefined, ["123", "456"]);
    expect(approvers(ctx)).toStrictEqual([]);
    expect(isApprover({ ...ctx, senderId: "789" })).toBe(false);
  });

  it("normalizes global exec approvers and preserves explicit overrides", () => {
    const ctx = approvalConfig(
      { enabled: "auto" },
      "discord:123 discord:user:123 user:456 789 discord:<@987> user:<@654> pk:999".split(" "),
    );
    expect(approvers(ctx)).toEqual(["123", "456", "789", "987", "654"]);
    expect(approvalsEnabled(ctx)).toBe(true);
    expect(isApprover({ ...ctx, senderId: "456" })).toBe(true);
    expect(approvers({ ...ctx, configOverride: { approvers: ["discord:user:456"] } })).toEqual([
      "456",
    ]);
  });
});
