// Msteams tests cover channel plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { MSTeamsConfigSchema } from "../config-api.js";
import { msteamsDirectoryContractPlugin } from "../directory-contract-api.js";
import {
  listMSTeamsAccountIds,
  resolveMSTeamsAccount,
  resolveMSTeamsAccountConfig,
} from "./accounts.js";
import { msTeamsApprovalAuth } from "./approval-auth.js";
import { msteamsPlugin } from "./channel.js";

function createConfiguredMSTeamsCfg(): OpenClawConfig {
  return {
    channels: {
      msteams: {
        appId: "app-id",
        appPassword: "secret",
        tenantId: "tenant-id",
      },
    },
  };
}

describe("msteamsPlugin", () => {
  it("exposes approval auth through approvalCapability", () => {
    expect(msteamsPlugin.approvalCapability).toBe(msTeamsApprovalAuth);
  });

  it("advertises legacy and group-management message-tool actions together", () => {
    const actions = msteamsPlugin.actions?.describeMessageTool?.({
      cfg: createConfiguredMSTeamsCfg(),
    })?.actions;

    expect(actions).toEqual([
      "upload-file",
      "poll",
      "edit",
      "delete",
      "pin",
      "unpin",
      "list-pins",
      "read",
      "react",
      "reactions",
      "search",
      "member-info",
      "channel-list",
      "channel-info",
      "addParticipant",
      "removeParticipant",
      "renameGroup",
    ]);
  });

  it("uses account-scoped Teams credentials for message-tool discovery", () => {
    const cfg = {
      channels: {
        msteams: {
          enabled: true,
          tenantId: "tenant-id",
          accounts: {
            support: {
              appId: "support-app-id",
              appPassword: "support-secret",
              webhook: { port: 3979 },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      msteamsPlugin.actions?.describeMessageTool?.({
        cfg,
        accountId: "default",
      })?.actions,
    ).toEqual([]);
    expect(
      msteamsPlugin.actions?.describeMessageTool?.({
        cfg,
        accountId: "support",
      })?.actions,
    ).toContain("upload-file");
  });

  it("does not advertise message tools for disabled or unconfigured named accounts", () => {
    const previousEnv = {
      appId: process.env.MSTEAMS_APP_ID,
      appPassword: process.env.MSTEAMS_APP_PASSWORD,
      tenantId: process.env.MSTEAMS_TENANT_ID,
    };
    process.env.MSTEAMS_APP_ID = "env-app-id";
    process.env.MSTEAMS_APP_PASSWORD = "env-secret";
    process.env.MSTEAMS_TENANT_ID = "env-tenant-id";
    try {
      const cfg = {
        channels: {
          msteams: {
            enabled: true,
            tenantId: "tenant-id",
            accounts: {
              disabled: {
                enabled: false,
                appId: "disabled-app-id",
                appPassword: "disabled-secret",
                webhook: { port: 3979 },
              },
              unconfigured: {
                appId: "unconfigured-app-id",
                webhook: { port: 3980 },
              },
            },
          },
        },
      } as OpenClawConfig;

      expect(
        msteamsPlugin.actions?.describeMessageTool?.({
          cfg,
          accountId: "disabled",
        })?.actions,
      ).toEqual([]);
      expect(
        msteamsPlugin.actions?.describeMessageTool?.({
          cfg,
          accountId: "unconfigured",
        })?.actions,
      ).toEqual([]);
    } finally {
      if (previousEnv.appId === undefined) {
        delete process.env.MSTEAMS_APP_ID;
      } else {
        process.env.MSTEAMS_APP_ID = previousEnv.appId;
      }
      if (previousEnv.appPassword === undefined) {
        delete process.env.MSTEAMS_APP_PASSWORD;
      } else {
        process.env.MSTEAMS_APP_PASSWORD = previousEnv.appPassword;
      }
      if (previousEnv.tenantId === undefined) {
        delete process.env.MSTEAMS_TENANT_ID;
      } else {
        process.env.MSTEAMS_TENANT_ID = previousEnv.tenantId;
      }
    }
  });

  it("does not resolve legacy root credentials for arbitrary named accounts", () => {
    const cfg = createConfiguredMSTeamsCfg();
    const resolved = resolveMSTeamsAccountConfig(cfg, "typo-account");

    expect(resolved.appId).toBeUndefined();
    expect(resolved.appPassword).toBeUndefined();
    expect(resolved.tenantId).toBe("tenant-id");
    expect(resolveMSTeamsAccount({ cfg, accountId: "typo-account" })).toMatchObject({
      accountId: "typo-account",
      configured: false,
    });
  });

  it("reuses the shared Teams target-id matcher for explicit targets", () => {
    const looksLikeId = msteamsPlugin.messaging?.targetResolver?.looksLikeId;

    expect(looksLikeId?.("29:1a2b3c4d5e6f")).toBe(true);
    expect(looksLikeId?.("a:1bfPersonalChat")).toBe(true);
    expect(looksLikeId?.("user:Jane Doe")).toBe(false);
  });
});

describe("msteams config schema", () => {
  it("defaults groupPolicy to allowlist", () => {
    const res = MSTeamsConfigSchema.safeParse({});

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.groupPolicy).toBe("allowlist");
    }
  });

  it("accepts historyLimit", () => {
    const res = MSTeamsConfigSchema.safeParse({ historyLimit: 4 });

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.historyLimit).toBe(4);
    }
  });

  it("accepts replyStyle at global/team/channel levels", () => {
    const res = MSTeamsConfigSchema.safeParse({
      replyStyle: "top-level",
      teams: {
        team123: {
          replyStyle: "thread",
          channels: {
            chan456: { replyStyle: "top-level" },
          },
        },
      },
    });

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.replyStyle).toBe("top-level");
      expect(res.data.teams?.team123?.replyStyle).toBe("thread");
      expect(res.data.teams?.team123?.channels?.chan456?.replyStyle).toBe("top-level");
    }
  });

  it("accepts Teams SDK cloud and serviceUrl configuration", () => {
    const res = MSTeamsConfigSchema.safeParse({
      cloud: "USGovDoD",
      serviceUrl: "https://smba.infra.dod.teams.microsoft.us/teams",
    });

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.cloud).toBe("USGovDoD");
      expect(res.data.serviceUrl).toBe("https://smba.infra.dod.teams.microsoft.us/teams");
    }
  });

  it("rejects unsupported Teams serviceUrl hosts", () => {
    const res = MSTeamsConfigSchema.safeParse({
      cloud: "USGovDoD",
      serviceUrl: "https://dod.example.mil/teams",
    });

    expect(res.success).toBe(false);
  });

  it("accepts China cloud without a configured global serviceUrl", () => {
    const res = MSTeamsConfigSchema.safeParse({
      cloud: "China",
    });

    expect(res.success).toBe(true);
  });

  it("accepts Azure China Bot Framework serviceUrl hosts", () => {
    const res = MSTeamsConfigSchema.safeParse({
      cloud: "China",
      serviceUrl: "https://msteams.botframework.azure.cn/teams",
    });

    expect(res.success).toBe(true);
  });

  it("rejects non-China serviceUrl hosts when China cloud is configured", () => {
    const res = MSTeamsConfigSchema.safeParse({
      cloud: "China",
      serviceUrl: "https://smba.trafficmanager.net/teams",
    });

    expect(res.success).toBe(false);
  });

  it("rejects Azure China Bot Framework serviceUrl hosts without China cloud", () => {
    const res = MSTeamsConfigSchema.safeParse({
      serviceUrl: "https://msteams.botframework.azure.cn/teams",
    });

    expect(res.success).toBe(false);
  });

  it("requires serviceUrl with non-public Teams clouds", () => {
    const res = MSTeamsConfigSchema.safeParse({
      cloud: "USGov",
    });

    expect(res.success).toBe(false);
  });

  it("rejects invalid replyStyle", () => {
    const res = MSTeamsConfigSchema.safeParse({
      replyStyle: "nope",
    });

    expect(res.success).toBe(false);
  });

  it("accepts named Teams bot accounts with explicit identities and ports", () => {
    const res = MSTeamsConfigSchema.safeParse({
      tenantId: "tenant-id",
      webhook: { path: "/api/messages" },
      accounts: {
        default: {
          appId: "primary-app-id",
          appPassword: "primary-secret",
          webhook: { port: 3978 },
        },
        secondary: {
          appId: "secondary-app-id",
          appPassword: "secondary-secret",
          webhook: { port: 3979 },
        },
      },
      defaultAccount: "default",
    });

    expect(res.success).toBe(true);
  });

  it("rejects named Teams bot accounts with duplicate canonical account ids", () => {
    const res = MSTeamsConfigSchema.safeParse({
      tenantId: "tenant-id",
      webhook: { path: "/api/messages" },
      accounts: {
        "Support Bot": {
          appId: "support-app-id",
          appPassword: "support-secret",
          webhook: { port: 3979 },
        },
        "support-bot": {
          appId: "support-shadow-app-id",
          appPassword: "support-shadow-secret",
          webhook: { port: 3980 },
        },
      },
    });

    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ["accounts", "support-bot"],
            message: expect.stringContaining('duplicate canonical account id "support-bot"'),
          }),
        ]),
      );
    }
  });

  it("rejects named accounts that would inherit identity or port from root", () => {
    const res = MSTeamsConfigSchema.safeParse({
      appId: "primary-app-id",
      appPassword: "primary-secret",
      tenantId: "tenant-id",
      webhook: { port: 3978, path: "/api/messages" },
      accounts: {
        secondary: {
          appId: "secondary-app-id",
          appPassword: "secondary-secret",
        },
      },
    });

    expect(res.success).toBe(false);
  });

  it("rejects enabled named accounts without an effective tenant ID", () => {
    const res = MSTeamsConfigSchema.safeParse({
      accounts: {
        support: {
          appId: "support-app-id",
          appPassword: "support-secret",
          webhook: { port: 3979 },
        },
      },
    });

    expect(res.success).toBe(false);
  });

  it("rejects simultaneous root and accounts.default identity definitions", () => {
    const res = MSTeamsConfigSchema.safeParse({
      appId: "root-app-id",
      appPassword: "root-secret",
      tenantId: "tenant-id",
      accounts: {
        default: {
          appId: "default-app-id",
          appPassword: "default-secret",
          webhook: { port: 3978 },
        },
      },
    });

    expect(res.success).toBe(false);
  });

  it("rejects simultaneous root and canonical default account alias identity definitions", () => {
    const res = MSTeamsConfigSchema.safeParse({
      appId: "root-app-id",
      appPassword: "root-secret",
      tenantId: "tenant-id",
      accounts: {
        Default: {
          appId: "default-app-id",
          appPassword: "default-secret",
          webhook: { port: 3978 },
        },
      },
    });

    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ["accounts", "Default"],
            message: expect.stringContaining("default Teams identity"),
          }),
        ]),
      );
    }
  });

  it("treats canonical default account aliases as default account config", () => {
    const res = MSTeamsConfigSchema.safeParse({
      tenantId: "tenant-id",
      accounts: {
        Default: {
          appId: "default-app-id",
          appPassword: "default-secret",
        },
        secondary: {
          appId: "secondary-app-id",
          appPassword: "secondary-secret",
          webhook: { port: 3979 },
        },
      },
    });

    expect(res.success).toBe(true);
  });

  it("rejects duplicate enabled account webhook ports", () => {
    const res = MSTeamsConfigSchema.safeParse({
      tenantId: "tenant-id",
      accounts: {
        default: {
          appId: "primary-app-id",
          appPassword: "primary-secret",
          webhook: { port: 3978 },
        },
        secondary: {
          appId: "secondary-app-id",
          appPassword: "secondary-secret",
          webhook: { port: 3978 },
        },
      },
    });

    expect(res.success).toBe(false);
  });

  it("rejects named accounts that collide with accounts.default implicit webhook port", () => {
    const res = MSTeamsConfigSchema.safeParse({
      tenantId: "tenant-id",
      accounts: {
        default: {
          appId: "primary-app-id",
          appPassword: "primary-secret",
        },
        secondary: {
          appId: "secondary-app-id",
          appPassword: "secondary-secret",
          webhook: { port: 3978 },
        },
      },
    });

    expect(res.success).toBe(false);
  });

  it("rejects named accounts that collide with the implicit default webhook port", () => {
    const res = MSTeamsConfigSchema.safeParse({
      appId: "primary-app-id",
      appPassword: "primary-secret",
      tenantId: "tenant-id",
      accounts: {
        secondary: {
          appId: "secondary-app-id",
          appPassword: "secondary-secret",
          webhook: { port: 3978 },
        },
      },
    });

    expect(res.success).toBe(false);
  });

  it("rejects named accounts that collide with a metadata-only default account implicit port", () => {
    const res = MSTeamsConfigSchema.safeParse({
      appId: "primary-app-id",
      appPassword: "primary-secret",
      tenantId: "tenant-id",
      accounts: {
        default: {
          name: "Primary",
        },
        secondary: {
          appId: "secondary-app-id",
          appPassword: "secondary-secret",
          webhook: { port: 3978 },
        },
      },
    });

    expect(res.success).toBe(false);
  });

  it("allows metadata-only default account when named accounts use different ports", () => {
    const res = MSTeamsConfigSchema.safeParse({
      appId: "primary-app-id",
      appPassword: "primary-secret",
      tenantId: "tenant-id",
      accounts: {
        default: {
          name: "Primary",
        },
        secondary: {
          appId: "secondary-app-id",
          appPassword: "secondary-secret",
          webhook: { port: 3979 },
        },
      },
    });

    expect(res.success).toBe(true);
  });

  it("deletes the default account identity without leaving a root webhook port", () => {
    const cfg = {
      channels: {
        msteams: {
          appId: "primary-app-id",
          appPassword: "primary-secret",
          tenantId: "tenant-id",
          webhook: {
            port: 3978,
            path: "/api/messages",
          },
          accounts: {
            default: {
              name: "Primary",
            },
            support: {
              appId: "support-app-id",
              appPassword: "support-secret",
              webhook: { port: 3979 },
            },
          },
        },
      },
    } as OpenClawConfig;

    const next = msteamsPlugin.config?.deleteAccount?.({
      cfg,
      accountId: "default",
    });

    expect(next?.channels?.msteams).toEqual({
      tenantId: "tenant-id",
      webhook: {
        path: "/api/messages",
      },
      accounts: {
        support: {
          appId: "support-app-id",
          appPassword: "support-secret",
          webhook: { port: 3979 },
        },
      },
    });
  });

  it("allows duplicate webhook ports when one account is disabled", () => {
    const res = MSTeamsConfigSchema.safeParse({
      tenantId: "tenant-id",
      accounts: {
        default: {
          appId: "primary-app-id",
          appPassword: "primary-secret",
          webhook: { port: 3978 },
        },
        secondary: {
          enabled: false,
          appId: "secondary-app-id",
          appPassword: "secondary-secret",
          webhook: { port: 3978 },
        },
      },
    });

    expect(res.success).toBe(true);
  });

  it("rejects duplicate enabled account app IDs", () => {
    const res = MSTeamsConfigSchema.safeParse({
      tenantId: "tenant-id",
      accounts: {
        default: {
          appId: "shared-app-id",
          appPassword: "primary-secret",
          webhook: { port: 3978 },
        },
        secondary: {
          appId: "SHARED-APP-ID",
          appPassword: "secondary-secret",
          webhook: { port: 3979 },
        },
      },
    });

    expect(res.success).toBe(false);
  });

  it("allows duplicate app IDs when one account is disabled", () => {
    const res = MSTeamsConfigSchema.safeParse({
      tenantId: "tenant-id",
      accounts: {
        default: {
          appId: "shared-app-id",
          appPassword: "primary-secret",
          webhook: { port: 3978 },
        },
        secondary: {
          enabled: false,
          appId: "shared-app-id",
          appPassword: "secondary-secret",
          webhook: { port: 3979 },
        },
      },
    });

    expect(res.success).toBe(true);
  });

  it("allows a named account to reuse the root app ID when accounts.default is disabled", () => {
    const res = MSTeamsConfigSchema.safeParse({
      appId: "shared-app-id",
      appPassword: "legacy-secret",
      tenantId: "tenant-id",
      accounts: {
        default: {
          enabled: false,
        },
        support: {
          appId: "shared-app-id",
          appPassword: "support-secret",
          webhook: { port: 3979 },
        },
      },
    });

    expect(res.success).toBe(true);
  });

  it("rejects enabled named federated accounts without a certificate or managed identity", () => {
    const res = MSTeamsConfigSchema.safeParse({
      tenantId: "tenant-id",
      accounts: {
        secondary: {
          authType: "federated",
          appId: "secondary-app-id",
          webhook: { port: 3979 },
        },
      },
    });

    expect(res.success).toBe(false);
  });

  it("accepts enabled named federated accounts with inherited certificate config", () => {
    const res = MSTeamsConfigSchema.safeParse({
      authType: "federated",
      tenantId: "tenant-id",
      certificatePath: "/secure/secondary.pem",
      accounts: {
        secondary: {
          appId: "secondary-app-id",
          webhook: { port: 3979 },
        },
      },
    });

    expect(res.success).toBe(true);
  });
});

describe("msteams account config", () => {
  it("lists root default and named accounts", () => {
    const cfg = {
      channels: {
        msteams: {
          appId: "primary-app-id",
          appPassword: "primary-secret",
          tenantId: "tenant-id",
          webhook: { port: 3978 },
          accounts: {
            secondary: {
              appId: "secondary-app-id",
              appPassword: "secondary-secret",
              webhook: { port: 3979 },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(listMSTeamsAccountIds(cfg)).toEqual(["default", "secondary"]);
  });

  it("resolves display-style account keys through their canonical account ids", () => {
    const cfg = {
      channels: {
        msteams: {
          tenantId: "tenant-id",
          webhook: { path: "/api/messages" },
          accounts: {
            "Support Bot": {
              appId: "support-app-id",
              appPassword: "support-secret",
              webhook: { port: 3979 },
            },
          },
          defaultAccount: "Support Bot",
        },
      },
    } as unknown as OpenClawConfig;

    expect(listMSTeamsAccountIds(cfg)).toEqual(["support-bot"]);

    for (const accountId of ["Support Bot", "support-bot"]) {
      expect(resolveMSTeamsAccountConfig(cfg, accountId)).toMatchObject({
        appId: "support-app-id",
        appPassword: "support-secret",
        tenantId: "tenant-id",
        webhook: { port: 3979, path: "/api/messages" },
      });
      expect(resolveMSTeamsAccount({ cfg, accountId })).toMatchObject({
        accountId: "support-bot",
        configured: true,
        enabled: true,
      });
    }
  });

  it("keeps legacy root credentials as the implicit default account", () => {
    const cfg = {
      channels: {
        msteams: {
          appId: "legacy-app-id",
          appPassword: "legacy-secret",
          tenantId: "tenant-id",
          webhook: { port: 3978, path: "/api/messages" },
        },
      },
    } as unknown as OpenClawConfig;

    expect(listMSTeamsAccountIds(cfg)).toEqual(["default"]);
    expect(resolveMSTeamsAccountConfig(cfg)).toMatchObject({
      appId: "legacy-app-id",
      appPassword: "legacy-secret",
      tenantId: "tenant-id",
      webhook: { port: 3978, path: "/api/messages" },
    });
    expect(resolveMSTeamsAccount({ cfg })).toMatchObject({
      accountId: "default",
      configured: true,
      enabled: true,
    });
  });

  it("inherits shared webhook path but not identity or port for named accounts", () => {
    const cfg = {
      channels: {
        msteams: {
          appId: "primary-app-id",
          appPassword: "primary-secret",
          tenantId: "tenant-id",
          webhook: { port: 3978, path: "/api/messages" },
          dmPolicy: "open",
          allowFrom: ["*"],
          accounts: {
            secondary: {
              appId: "secondary-app-id",
              appPassword: "secondary-secret",
              webhook: { port: 3979 },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const secondary = resolveMSTeamsAccountConfig(cfg, "secondary");

    expect(secondary.appId).toBe("secondary-app-id");
    expect(secondary.appPassword).toBe("secondary-secret");
    expect(secondary.tenantId).toBe("tenant-id");
    expect(secondary.webhook).toEqual({ port: 3979, path: "/api/messages" });
    expect(secondary.allowFrom).toEqual(["*"]);
  });

  it("keeps identity when resolving an already account-scoped named account config", () => {
    const cfg = {
      channels: {
        msteams: {
          enabled: true,
          defaultAccount: "secondary",
          appId: "secondary-app-id",
          appPassword: "secondary-secret",
          tenantId: "tenant-id",
          webhook: { port: 3979, path: "/api/messages" },
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
    } as unknown as OpenClawConfig;

    const secondary = resolveMSTeamsAccountConfig(cfg, "secondary");

    expect(secondary.appId).toBe("secondary-app-id");
    expect(secondary.appPassword).toBe("secondary-secret");
    expect(secondary.tenantId).toBe("tenant-id");
    expect(secondary.webhook).toEqual({ port: 3979, path: "/api/messages" });
    expect(resolveMSTeamsAccount({ cfg, accountId: "secondary" }).configured).toBe(true);
  });

  it("marks named accounts without explicit identity as unconfigured", () => {
    const cfg = {
      channels: {
        msteams: {
          appId: "primary-app-id",
          appPassword: "primary-secret",
          tenantId: "tenant-id",
          webhook: { port: 3978, path: "/api/messages" },
          accounts: {
            secondary: {
              webhook: { port: 3979 },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(resolveMSTeamsAccount({ cfg, accountId: "secondary" }).configured).toBe(false);
  });
});

describe("msTeamsApprovalAuth", () => {
  it("authorizes stable Teams user ids and ignores display-name allowlists", () => {
    expect(
      msTeamsApprovalAuth.authorizeActorAction({
        cfg: {
          channels: {
            msteams: {
              allowFrom: ["user:123e4567-e89b-12d3-a456-426614174000"],
            },
          },
        },
        senderId: "123e4567-e89b-12d3-a456-426614174000",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ authorized: true });

    expect(
      msTeamsApprovalAuth.authorizeActorAction({
        cfg: {
          channels: { msteams: { allowFrom: ["Owner Display"] } },
        },
        senderId: "attacker-aad",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ authorized: true });
  });

  it("uses account-scoped approvers for named Teams accounts", () => {
    const rootApprover = "123e4567-e89b-12d3-a456-426614174000";
    const supportApprover = "223e4567-e89b-12d3-a456-426614174000";
    const cfg = {
      channels: {
        msteams: {
          allowFrom: [`user:${rootApprover}`],
          accounts: {
            support: {
              appId: "support-app-id",
              appPassword: "support-secret",
              allowFrom: [`user:${supportApprover}`],
              webhook: { port: 3979 },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      msTeamsApprovalAuth.authorizeActorAction({
        cfg,
        accountId: "support",
        senderId: supportApprover,
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ authorized: true });
    expect(
      msTeamsApprovalAuth.authorizeActorAction({
        cfg,
        accountId: "support",
        senderId: rootApprover,
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({
      authorized: false,
      reason: "❌ You are not authorized to approve exec requests on Microsoft Teams.",
    });
  });
});

describe("msteams directory contract", () => {
  it("uses account-scoped Teams config", async () => {
    const cfg = {
      channels: {
        msteams: {
          tenantId: "tenant-id",
          appId: "default-app-id",
          appPassword: "default-secret",
          allowFrom: ["user:default-user"],
          accounts: {
            support: {
              appId: "support-app-id",
              appPassword: "support-secret",
              allowFrom: ["user:support-user"],
              teams: {
                team1: {
                  channels: {
                    "19:support-channel": {},
                  },
                },
              },
              webhook: { port: 3979 },
            },
          },
        },
      },
    } as OpenClawConfig;

    await expect(
      msteamsDirectoryContractPlugin.directory.self?.({
        cfg,
        accountId: "support",
        runtime: {} as never,
      }),
    ).resolves.toEqual({ kind: "user", id: "support-app-id", name: "support-app-id" });
    await expect(
      msteamsDirectoryContractPlugin.directory.listPeers?.({
        cfg,
        accountId: "support",
        runtime: {} as never,
      }),
    ).resolves.toEqual([{ id: "user:support-user", kind: "user" }]);
    await expect(
      msteamsDirectoryContractPlugin.directory.listGroups?.({
        cfg,
        accountId: "support",
        runtime: {} as never,
      }),
    ).resolves.toEqual([{ id: "conversation:19:support-channel", kind: "group" }]);
  });

  it("does not use default env credentials for named directory accounts", async () => {
    const previousEnv = {
      appId: process.env.MSTEAMS_APP_ID,
      appPassword: process.env.MSTEAMS_APP_PASSWORD,
      tenantId: process.env.MSTEAMS_TENANT_ID,
    };
    process.env.MSTEAMS_APP_ID = "env-default-app";
    process.env.MSTEAMS_APP_PASSWORD = "env-default-secret";
    process.env.MSTEAMS_TENANT_ID = "env-default-tenant";
    try {
      const cfg = {
        channels: {
          msteams: {
            accounts: {
              support: {
                appId: "support-app-id",
                tenantId: "support-tenant-id",
                webhook: { port: 3979 },
              },
            },
          },
        },
      } as OpenClawConfig;

      await expect(
        msteamsDirectoryContractPlugin.directory.self?.({
          cfg,
          accountId: "support",
          runtime: {} as never,
        }),
      ).resolves.toBeNull();
    } finally {
      if (previousEnv.appId === undefined) {
        delete process.env.MSTEAMS_APP_ID;
      } else {
        process.env.MSTEAMS_APP_ID = previousEnv.appId;
      }
      if (previousEnv.appPassword === undefined) {
        delete process.env.MSTEAMS_APP_PASSWORD;
      } else {
        process.env.MSTEAMS_APP_PASSWORD = previousEnv.appPassword;
      }
      if (previousEnv.tenantId === undefined) {
        delete process.env.MSTEAMS_TENANT_ID;
      } else {
        process.env.MSTEAMS_TENANT_ID = previousEnv.tenantId;
      }
    }
  });
});
