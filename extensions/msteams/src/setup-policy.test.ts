import { describe, expect, it, vi } from "vitest";
import type { MSTeamsConfig, OpenClawConfig } from "../runtime-api.js";
import { resolveMSTeamsAccountConfig } from "./accounts.js";
import { msteamsSetupWizard } from "./setup-surface.js";

const resolveMSTeamsUserAllowlist = vi.hoisted(() => vi.fn());
const resolveMSTeamsChannelAllowlist = vi.hoisted(() =>
  vi.fn<typeof import("./resolve-allowlist.js").resolveMSTeamsChannelAllowlist>(),
);

vi.mock("./resolve-allowlist.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./resolve-allowlist.js")>()),
  resolveMSTeamsChannelAllowlist,
  resolveMSTeamsUserAllowlist,
}));

function teamsConfig(msteams: MSTeamsConfig): OpenClawConfig {
  return { channels: { msteams } };
}

const policy = msteamsSetupWizard.dmPolicy!;
const groups = msteamsSetupWizard.groupAccess!;
function policyKeys(prefix: string) {
  return { policyKey: `${prefix}.dmPolicy`, allowFromKey: `${prefix}.allowFrom` };
}

describe("msteamsSetupWizard account-scoped policies", () => {
  it("lists inherited and selected-account teams and channels in configured order", () => {
    const cfg = teamsConfig({
      teams: { inherited: {} },
      accounts: {
        "Support Bot": {
          teams: { whole: {}, scoped: { channels: { first: {}, second: {} } } },
        },
        sibling: { teams: { unrelated: {} } },
      },
    });

    expect(groups.currentEntries({ cfg, accountId: "support-bot" })).toEqual([
      "inherited",
      "whole",
      "scoped/first",
      "scoped/second",
    ]);
  });

  it("keeps resolved channels, teams, and unresolved entries in setup order", async () => {
    resolveMSTeamsChannelAllowlist.mockResolvedValueOnce([
      { input: "unknown/general", resolved: false },
      { input: "whole-team", resolved: true, teamId: "team-a" },
      { input: "channel", resolved: true, teamId: "team-b", channelId: "channel-b" },
      { input: "incomplete", resolved: true },
    ]);
    const note = vi.fn(async () => {});
    const resolved = await groups.resolveAllowlist!({
      cfg: teamsConfig({
        appId: "synthetic-app",
        appPassword: "synthetic-secret",
        tenantId: "synthetic-tenant",
      }),
      accountId: "default",
      credentialValues: {},
      entries: ["unknown/general", "whole-team", "channel", "incomplete"],
      prompter: { note },
    });

    expect(resolved).toEqual([
      { teamKey: "team-b", channelKey: "channel-b" },
      { teamKey: "team-a" },
      { teamKey: "unknown", channelKey: "general" },
    ]);
    expect(note).toHaveBeenCalledWith(
      "Resolved channels: channel-b\nResolved teams: team-a\nUnresolved (kept as typed): unknown/general",
      "MS Teams channels",
    );
  });

  it("reads and edits root DM policy without consuming its SecretRef", () => {
    const secret = { source: "env" as const, provider: "default", id: "TEAMS_POLICY_SECRET" };
    const account = {
      appId: "synthetic-app",
      tenantId: "synthetic-tenant",
      appPassword: secret,
      dmPolicy: "allowlist" as const,
      allowFrom: ["user-1"],
    };
    const cfg = teamsConfig(account);
    const before = structuredClone(cfg);
    const accountId = "default";

    expect(policy.getCurrent(cfg)).toBe("allowlist");
    expect(policy.resolveConfigKeys?.(cfg, accountId)).toEqual(policyKeys("channels.msteams"));
    const next = policy.setPolicy(cfg, "open", accountId);
    expect(resolveMSTeamsAccountConfig(next, accountId)).toMatchObject({
      dmPolicy: "open",
      allowFrom: ["user-1", "*"],
      appPassword: secret,
    });
    expect(cfg).toEqual(before);
    expect(next.channels?.msteams?.accounts).toBeUndefined();
  });

  it("re-enables the selected account without opening a globally disabled sibling", () => {
    const next = groups.setPolicy({
      cfg: teamsConfig({
        enabled: false,
        accounts: {
          sibling: { enabled: true, groupPolicy: "allowlist" },
          support: { enabled: false, groupPolicy: "disabled" },
        },
      }),
      accountId: "support",
      policy: "allowlist",
    });

    expect(next.channels?.msteams).toMatchObject({
      enabled: true,
      accounts: {
        sibling: { enabled: false, groupPolicy: "allowlist" },
        support: { enabled: true, groupPolicy: "allowlist" },
      },
    });
  });

  it("writes the root default policy without changing siblings", () => {
    const inherited = {
      dmPolicy: "allowlist",
      allowFrom: ["root-user"],
      groupPolicy: "allowlist",
    } as const;
    const cfg = teamsConfig({
      defaultAccount: "default",
      ...inherited,
      allowFrom: [...inherited.allowFrom],
      appId: "default-app",
      appPassword: "default-secret",
      tenantId: "tenant-id",
      accounts: {
        support: { appId: "support-app", appPassword: "support-secret", tenantId: "tenant-id" },
      },
    });
    const opened = policy.setPolicy(cfg, "open", "default");
    const disabled = groups.setPolicy({
      cfg: opened,
      accountId: "default",
      policy: "disabled",
    });
    expect(disabled.channels?.msteams).toMatchObject(inherited);
    expect(resolveMSTeamsAccountConfig(disabled, "default")).toMatchObject({
      dmPolicy: "open",
      groupPolicy: "disabled",
      allowFrom: ["root-user", "*"],
    });
    expect(resolveMSTeamsAccountConfig(disabled, "support")).toMatchObject(inherited);
    expect(Object.keys(disabled.channels?.msteams?.accounts ?? {})).toEqual(
      expect.arrayContaining(["default", "support"]),
    );
    expect(disabled.channels?.msteams?.accounts).not.toHaveProperty("Default");
  });

  it("writes an explicit default account group allowlist without changing its sibling", () => {
    const cfg = teamsConfig({
      defaultAccount: "Default",
      teams: { root: {} },
      accounts: {
        Default: { teams: { existing: {} } },
        support: { teams: { support: {} } },
      },
    });

    const next = groups.applyAllowlist?.({
      cfg,
      accountId: "default",
      resolved: [{ teamKey: "team-a", channelKey: "channel-a" }],
    });

    expect(next?.channels?.msteams).toMatchObject({
      teams: { root: {} },
      accounts: {
        Default: {
          teams: {
            existing: {},
            "team-a": { channels: { "channel-a": {} } },
          },
        },
        support: { teams: { support: {} } },
      },
    });
    expect(next?.channels?.msteams?.accounts).not.toHaveProperty("default");
  });

  it("preserves a display-style key for policy paths and allowlist writes", async () => {
    resolveMSTeamsUserAllowlist.mockReset();
    resolveMSTeamsUserAllowlist.mockResolvedValue([
      { input: "alex@example.com", resolved: true, id: "user-2" },
    ]);
    const cfg = teamsConfig({
      defaultAccount: "Support Bot",
      accounts: {
        "Support Bot": { dmPolicy: "allowlist" as const, allowFrom: ["user-1"] },
      },
    });

    expect(policy.resolveConfigKeys?.(cfg, "support-bot")).toEqual(
      policyKeys("channels.msteams.accounts.Support Bot"),
    );

    const next = await policy.promptAllowFrom!({
      cfg,
      accountId: "support-bot",
      prompter: {
        note: vi.fn(async () => {}),
        text: vi.fn(async () => "alex@example.com"),
      },
    } as never);

    expect(next.channels?.msteams?.accounts?.["Support Bot"]).toMatchObject({
      dmPolicy: "allowlist",
      allowFrom: ["user-1", "user-2"],
    });
    expect(next.channels?.msteams?.accounts).not.toHaveProperty("support-bot");
  });
  it("reports account-scoped config keys before the account is configured", () => {
    expect(policy.resolveConfigKeys?.({}, "support")).toEqual(
      policyKeys("channels.msteams.accounts.support"),
    );
  });
});
