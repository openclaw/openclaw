// Msteams tests cover account-scoped setup policy behavior.
import { installChannelDmPolicyContractSuite } from "openclaw/plugin-sdk/channel-test-helpers";
import { describe, expect, it, vi } from "vitest";
import { msteamsSetupWizard } from "./setup-surface.js";

const resolveMSTeamsUserAllowlist = vi.hoisted(() => vi.fn());

vi.mock("./resolve-allowlist.js", () => ({
  parseMSTeamsTeamEntry: vi.fn(),
  resolveMSTeamsChannelAllowlist: vi.fn(),
  resolveMSTeamsUserAllowlist,
}));

describe("msteamsSetupWizard account-scoped policies", () => {
  it("keeps legacy default policy writes at the channel root", () => {
    const cfg = {
      channels: {
        msteams: {
          dmPolicy: "allowlist" as const,
          allowFrom: ["root-user"],
        },
      },
    };

    const next = msteamsSetupWizard.dmPolicy!.setPolicy(cfg, "open");

    expect(next.channels?.msteams).toMatchObject({
      dmPolicy: "open",
      allowFrom: ["root-user", "*"],
    });
    expect(next.channels?.msteams?.accounts).toBeUndefined();
  });

  it("writes an explicit default account without changing its sibling", () => {
    const cfg = {
      channels: {
        msteams: {
          defaultAccount: "Default",
          dmPolicy: "disabled" as const,
          allowFrom: ["root-user"],
          accounts: {
            Default: {
              dmPolicy: "allowlist" as const,
              allowFrom: ["default-user"],
            },
            support: {
              dmPolicy: "allowlist" as const,
              allowFrom: ["support-user"],
              groupPolicy: "allowlist" as const,
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
      dmPolicy: "disabled",
      allowFrom: ["root-user"],
      accounts: {
        Default: {
          dmPolicy: "open",
          allowFrom: ["default-user", "*"],
          groupPolicy: "disabled",
        },
        support: {
          dmPolicy: "allowlist",
          allowFrom: ["support-user"],
          groupPolicy: "allowlist",
        },
      },
    });
    expect(disabled.channels?.msteams?.accounts).not.toHaveProperty("default");
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
  installChannelDmPolicyContractSuite({
    dmPolicy: msteamsSetupWizard.dmPolicy!,
    cases: [
      {
        name: "Teams named accounts",
        channel: "msteams",
        accountId: "support",
        accountConfig: {
          appId: "support-app",
          appPassword: "support-secret",
          tenantId: "support-tenant",
        },
        inheritedAllowFrom: ["user-1"],
        defaultAccount: { rootAllowFrom: ["root-user"] },
      },
    ],
  });
});
