import { describe, expect, it, vi } from "vitest";
import { resolveMSTeamsAccountConfig } from "./accounts.js";
import { msteamsSetupWizard } from "./setup-surface.js";

const resolveMSTeamsUserAllowlist = vi.hoisted(() => vi.fn());

vi.mock("./resolve-allowlist.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./resolve-allowlist.js")>()),
  resolveMSTeamsChannelAllowlist: vi.fn(),
  resolveMSTeamsUserAllowlist,
}));

describe("msteamsSetupWizard account-scoped policies", () => {
  it("reads and edits root DM policy without consuming its SecretRef", () => {
    const secret = { source: "env" as const, provider: "default", id: "TEAMS_POLICY_SECRET" };
    const account = {
      appId: "synthetic-app",
      tenantId: "synthetic-tenant",
      appPassword: secret,
      dmPolicy: "allowlist" as const,
      allowFrom: ["user-1"],
    };
    const cfg = {
      channels: {
        msteams: account,
      },
    };
    const before = structuredClone(cfg);
    const policy = msteamsSetupWizard.dmPolicy!;
    const accountId = "default";

    expect(policy.getCurrent(cfg)).toBe("allowlist");
    expect(policy.resolveConfigKeys?.(cfg, accountId)).toEqual({
      policyKey: "channels.msteams.dmPolicy",
      allowFromKey: "channels.msteams.allowFrom",
    });
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
    const next = msteamsSetupWizard.groupAccess!.setPolicy({
      cfg: {
        channels: {
          msteams: {
            enabled: false,
            accounts: {
              sibling: { enabled: true, groupPolicy: "allowlist" },
              support: {
                enabled: false,
                groupPolicy: "disabled",
              },
            },
          },
        },
      },
      accountId: "support",
      policy: "allowlist",
    });

    expect(next.channels?.msteams).toMatchObject({
      enabled: true,
      accounts: {
        sibling: { enabled: false, groupPolicy: "allowlist" },
        support: {
          enabled: true,
          groupPolicy: "allowlist",
        },
      },
    });
  });

  it("writes the root default policy without changing siblings", () => {
    const cfg = {
      channels: {
        msteams: {
          defaultAccount: "default",
          dmPolicy: "allowlist" as const,
          allowFrom: ["root-user"],
          groupPolicy: "allowlist" as const,
          appId: "default-app",
          appPassword: "default-secret",
          tenantId: "tenant-id",
          accounts: {
            support: {
              appId: "support-app",
              appPassword: "support-secret",
              tenantId: "tenant-id",
            },
          },
        },
      },
    };
    const opened = msteamsSetupWizard.dmPolicy!.setPolicy(cfg, "open", "default");
    const disabled = msteamsSetupWizard.groupAccess!.setPolicy({
      cfg: opened,
      accountId: "default",
      policy: "disabled",
    });
    expect(disabled.channels?.msteams).toMatchObject({
      dmPolicy: "allowlist",
      allowFrom: ["root-user"],
      groupPolicy: "allowlist",
    });
    expect(resolveMSTeamsAccountConfig(disabled, "default")).toMatchObject({
      dmPolicy: "open",
      groupPolicy: "disabled",
      allowFrom: ["root-user", "*"],
    });
    expect(resolveMSTeamsAccountConfig(disabled, "support")).toMatchObject({
      dmPolicy: "allowlist",
      allowFrom: ["root-user"],
      groupPolicy: "allowlist",
    });
    expect(Object.keys(disabled.channels?.msteams?.accounts ?? {})).toEqual(
      expect.arrayContaining(["default", "support"]),
    );
    expect(disabled.channels?.msteams?.accounts).not.toHaveProperty("Default");
  });

  it("writes an explicit default account group allowlist without changing its sibling", () => {
    const cfg = {
      channels: {
        msteams: {
          defaultAccount: "Default",
          teams: { root: {} },
          accounts: {
            Default: {
              teams: { existing: {} },
            },
            support: {
              teams: { support: {} },
            },
          },
        },
      },
    };

    const next = msteamsSetupWizard.groupAccess!.applyAllowlist?.({
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
        support: {
          teams: { support: {} },
        },
      },
    });
    expect(next?.channels?.msteams?.accounts).not.toHaveProperty("default");
  });

  it("preserves a display-style key for policy paths and allowlist writes", async () => {
    resolveMSTeamsUserAllowlist.mockReset();
    resolveMSTeamsUserAllowlist.mockResolvedValue([
      { input: "alex@example.com", resolved: true, id: "user-2" },
    ]);
    const cfg = {
      channels: {
        msteams: {
          defaultAccount: "Support Bot",
          accounts: {
            "Support Bot": {
              dmPolicy: "allowlist" as const,
              allowFrom: ["user-1"],
            },
          },
        },
      },
    };

    expect(msteamsSetupWizard.dmPolicy!.resolveConfigKeys?.(cfg, "support-bot")).toEqual({
      policyKey: "channels.msteams.accounts.Support Bot.dmPolicy",
      allowFromKey: "channels.msteams.accounts.Support Bot.allowFrom",
    });

    const next = await msteamsSetupWizard.dmPolicy!.promptAllowFrom!({
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
});

describe("msteamsSetupWizard.dmPolicy", () => {
  it("reports account-scoped config keys before the account is configured", () => {
    expect(msteamsSetupWizard.dmPolicy!.resolveConfigKeys?.({}, "support")).toEqual({
      policyKey: "channels.msteams.accounts.support.dmPolicy",
      allowFromKey: "channels.msteams.accounts.support.allowFrom",
    });
  });
});
