// Msteams tests cover setup surface plugin behavior.
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/setup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMSTeamsSetupWizardBase, msteamsSetupAdapter } from "./setup-core.js";
import { msteamsSetupWizard as exportedMSTeamsSetupWizard } from "./setup-surface.js";

const resolveMSTeamsUserAllowlist = vi.hoisted(() => vi.fn());
const resolveMSTeamsChannelAllowlist = vi.hoisted(() => vi.fn());
const normalizeSecretInputString = vi.hoisted(() =>
  vi.fn((value: unknown) => (typeof value === "string" ? value.trim() || undefined : undefined)),
);
const hasConfiguredMSTeamsCredentials = vi.hoisted(() => vi.fn());
const resolveMSTeamsCredentials = vi.hoisted(() => vi.fn());
const saveDelegatedTokens = vi.hoisted(() => vi.fn());

vi.mock("./resolve-allowlist.js", () => ({
  parseMSTeamsTeamEntry: vi.fn(),
  resolveMSTeamsChannelAllowlist,
  resolveMSTeamsUserAllowlist,
}));

vi.mock("./secret-input.js", () => ({
  normalizeSecretInputString,
}));

vi.mock("./token.js", () => ({
  hasConfiguredMSTeamsCredentials,
  resolveMSTeamsCredentials,
  saveDelegatedTokens,
}));

vi.mock("./oauth.js", () => ({
  loginMSTeamsDelegated: vi.fn(async () => ({
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt: Date.parse("2030-01-01T00:00:00.000Z"),
    scopes: ["ChatMessage.Send"],
  })),
}));

describe("msteams setup surface", () => {
  const msteamsSetupWizard = createMSTeamsSetupWizardBase();

  beforeEach(() => {
    resolveMSTeamsUserAllowlist.mockReset();
    resolveMSTeamsChannelAllowlist.mockReset();
    normalizeSecretInputString.mockClear();
    hasConfiguredMSTeamsCredentials.mockReset();
    resolveMSTeamsCredentials.mockReset();
    saveDelegatedTokens.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolves the requested account id", () => {
    expect(msteamsSetupAdapter.resolveAccountId?.({ accountId: "work" } as never)).toBe("work");
  });

  it("enables the msteams channel and promotes existing default identity", () => {
    expect(
      msteamsSetupAdapter.applyAccountConfig?.({
        cfg: {
          channels: {
            msteams: {
              appId: "existing-app",
            },
          },
        },
        accountId: DEFAULT_ACCOUNT_ID,
        input: {},
      } as never),
    ).toEqual({
      channels: {
        msteams: {
          enabled: true,
          accounts: {
            default: {
              enabled: true,
              appId: "existing-app",
            },
          },
        },
      },
    });
  });

  it("applies named account config without moving shared root defaults", () => {
    expect(
      msteamsSetupAdapter.applyAccountConfig?.({
        cfg: {
          channels: {
            msteams: {
              tenantId: "shared-tenant",
              dmPolicy: "allowlist",
              allowFrom: ["user-1"],
            },
          },
        },
        accountId: "support",
        input: {
          appId: "support-app",
          appPassword: "support-secret",
          tenantId: "tenant-id",
        },
      } as never),
    ).toEqual({
      channels: {
        msteams: {
          tenantId: "shared-tenant",
          dmPolicy: "allowlist",
          allowFrom: ["user-1"],
          enabled: true,
          accounts: {
            support: {
              enabled: true,
              appId: "support-app",
              appPassword: "support-secret",
              tenantId: "tenant-id",
            },
          },
        },
      },
    });
  });

  it("promotes root identity when adding a named account", () => {
    expect(
      msteamsSetupAdapter.applyAccountConfig?.({
        cfg: {
          channels: {
            msteams: {
              appId: "default-app",
              appPassword: "default-secret",
              tenantId: "shared-tenant",
              webhook: { port: 3978, path: "/api/messages" },
            },
          },
        },
        accountId: "support",
        input: {
          appId: "support-app",
          appPassword: "support-secret",
          tenantId: "tenant-id",
        },
      } as never),
    ).toEqual({
      channels: {
        msteams: {
          tenantId: "shared-tenant",
          webhook: { path: "/api/messages" },
          enabled: true,
          accounts: {
            default: {
              appId: "default-app",
              appPassword: "default-secret",
              webhook: { port: 3978 },
            },
            support: {
              enabled: true,
              appId: "support-app",
              appPassword: "support-secret",
              tenantId: "tenant-id",
            },
          },
        },
      },
    });
  });

  it("rejects env credentials for named accounts", () => {
    expect(
      msteamsSetupAdapter.validateInput?.({
        accountId: "support",
        input: { useEnv: true },
      } as never),
    ).toBe("MSTEAMS_* environment variables can only be used for the default account.");
  });

  it("re-enables a disabled named account when setup configures it", () => {
    expect(
      msteamsSetupAdapter.applyAccountConfig?.({
        cfg: {
          channels: {
            msteams: {
              accounts: {
                support: {
                  enabled: false,
                  appId: "old-app",
                },
              },
            },
          },
        },
        accountId: "support",
        input: {
          appId: "support-app",
          appPassword: "support-secret",
          tenantId: "tenant-id",
        },
      } as never),
    ).toEqual({
      channels: {
        msteams: {
          enabled: true,
          accounts: {
            support: {
              enabled: true,
              appId: "support-app",
              appPassword: "support-secret",
              tenantId: "tenant-id",
            },
          },
        },
      },
    });
  });

  it("reports configured status from resolved credentials", () => {
    resolveMSTeamsCredentials.mockReturnValue({
      appId: "app",
    });
    hasConfiguredMSTeamsCredentials.mockReturnValue(false);

    expect(
      msteamsSetupWizard.status.resolveConfigured({
        cfg: { channels: { msteams: {} } },
      } as never),
    ).toBe(true);
  });

  it("reports configured status from configured credentials and renders status lines", async () => {
    resolveMSTeamsCredentials.mockReturnValue(null);
    hasConfiguredMSTeamsCredentials.mockReturnValue(true);

    expect(
      msteamsSetupWizard.status.resolveConfigured({
        cfg: { channels: { msteams: {} } },
      } as never),
    ).toBe(true);

    hasConfiguredMSTeamsCredentials.mockReturnValue(false);
    expect(msteamsSetupWizard.status.resolveStatusLines).toBeTypeOf("function");
    await expect(
      msteamsSetupWizard.status.resolveStatusLines?.({
        cfg: { channels: { msteams: {} } },
      } as never),
    ).resolves.toEqual(["MS Teams: needs app credentials"]);
  });

  it("finalize keeps env credentials when available and accepted", async () => {
    vi.stubEnv("MSTEAMS_APP_ID", "env-app");
    vi.stubEnv("MSTEAMS_APP_PASSWORD", "env-secret");
    vi.stubEnv("MSTEAMS_TENANT_ID", "env-tenant");
    resolveMSTeamsCredentials.mockReturnValue(null);
    hasConfiguredMSTeamsCredentials.mockReturnValue(false);

    const result = await msteamsSetupWizard.finalize?.({
      cfg: { channels: { msteams: { existing: true } } },
      prompter: {
        confirm: vi.fn(async () => true),
        note: vi.fn(async () => {}),
        text: vi.fn(),
      },
    } as never);

    expect(result).toEqual({
      accountId: "default",
      cfg: {
        channels: {
          msteams: {
            existing: true,
            enabled: true,
          },
        },
      },
    });
  });

  it("finalize prompts for manual credentials when env/config creds are unavailable", async () => {
    resolveMSTeamsCredentials.mockReturnValue(null);
    hasConfiguredMSTeamsCredentials.mockReturnValue(false);
    const note = vi.fn(async () => {});
    const confirm = vi.fn(async () => false);
    const text = vi.fn(async ({ message }: { message: string }) => {
      if (message === "Enter MS Teams App ID") {
        return "app-id";
      }
      if (message === "Enter MS Teams App Password") {
        return "app-password";
      }
      if (message === "Enter MS Teams Tenant ID") {
        return "tenant-id";
      }
      throw new Error(`Unexpected prompt: ${message}`);
    });

    const result = await msteamsSetupWizard.finalize?.({
      cfg: { channels: { msteams: {} } },
      prompter: {
        confirm,
        note,
        text,
      },
    } as never);

    expect(note).toHaveBeenCalled();
    expect(result).toEqual({
      accountId: "default",
      cfg: {
        channels: {
          msteams: {
            enabled: true,
            accounts: {
              default: {
                enabled: true,
                appId: "app-id",
                appPassword: "app-password",
                tenantId: "tenant-id",
              },
            },
          },
        },
      },
    });
  });

  it("finalize configures named accounts with credentials and webhook port", async () => {
    resolveMSTeamsCredentials.mockReturnValue(null);
    hasConfiguredMSTeamsCredentials.mockReturnValue(false);
    const note = vi.fn(async () => {});
    const confirm = vi.fn(async () => false);
    const text = vi.fn(async ({ message }: { message: string }) => {
      if (message === "Enter MS Teams App ID") {
        return "support-app";
      }
      if (message === "Enter MS Teams App Password") {
        return "support-password";
      }
      if (message === "Enter MS Teams Tenant ID") {
        return "tenant-id";
      }
      if (message === "Enter MS Teams webhook port") {
        return "3979";
      }
      throw new Error(`Unexpected prompt: ${message}`);
    });

    const result = await msteamsSetupWizard.finalize?.({
      cfg: {
        channels: {
          msteams: {
            tenantId: "shared-tenant",
            webhook: { path: "/api/messages" },
            dmPolicy: "allowlist",
            allowFrom: ["user-1"],
          },
        },
      },
      accountId: "support",
      prompter: {
        confirm,
        note,
        text,
      },
    } as never);

    expect(result).toEqual({
      accountId: "support",
      cfg: {
        channels: {
          msteams: {
            tenantId: "shared-tenant",
            webhook: { path: "/api/messages" },
            dmPolicy: "allowlist",
            allowFrom: ["user-1"],
            enabled: true,
            accounts: {
              support: {
                enabled: true,
                appId: "support-app",
                appPassword: "support-password",
                tenantId: "tenant-id",
                webhook: { port: 3979 },
              },
            },
          },
        },
      },
    });
  });

  it("finalize keeps existing federated named account credentials", async () => {
    resolveMSTeamsCredentials.mockReturnValue({
      type: "federated",
      appId: "support-app",
      tenantId: "tenant-id",
      certificatePath: "/secure/support.pem",
    });
    hasConfiguredMSTeamsCredentials.mockReturnValue(false);
    const confirm = vi.fn(async () => true);
    const text = vi.fn();

    const result = await msteamsSetupWizard.finalize?.({
      cfg: {
        channels: {
          msteams: {
            accounts: {
              support: {
                authType: "federated",
                appId: "support-app",
                tenantId: "tenant-id",
                certificatePath: "/secure/support.pem",
                webhook: { port: 3979 },
              },
            },
          },
        },
      },
      accountId: "support",
      prompter: {
        confirm,
        note: vi.fn(async () => {}),
        text,
      },
    } as never);

    expect(result).toEqual({
      accountId: "support",
      cfg: {
        channels: {
          msteams: {
            accounts: {
              support: {
                authType: "federated",
                appId: "support-app",
                tenantId: "tenant-id",
                certificatePath: "/secure/support.pem",
                webhook: { port: 3979 },
              },
            },
          },
        },
      },
    });
    expect(confirm).toHaveBeenCalledWith({
      message: "MS Teams credentials already configured. Keep them?",
      initialValue: true,
    });
    expect(text).not.toHaveBeenCalled();
  });

  it("finalize stores delegated auth under the resolved named account", async () => {
    resolveMSTeamsCredentials.mockReturnValue({
      type: "secret",
      appId: "support-app",
      appPassword: "support-password",
      tenantId: "tenant-id",
    });
    hasConfiguredMSTeamsCredentials.mockReturnValue(true);
    const progress = { update: vi.fn(), stop: vi.fn() };

    const result = await exportedMSTeamsSetupWizard.finalize?.({
      cfg: {
        channels: {
          msteams: {
            accounts: {
              support: {
                appId: "support-app",
                appPassword: "support-password",
                tenantId: "tenant-id",
                webhook: { port: 3979 },
              },
            },
          },
        },
      },
      accountId: "support",
      prompter: {
        confirm: vi.fn(async () => true),
        note: vi.fn(async () => {}),
        progress: vi.fn(() => progress),
        text: vi.fn(),
      },
    } as never);

    expect(result?.cfg?.channels?.msteams?.accounts?.support).toEqual({
      appId: "support-app",
      appPassword: "support-password",
      tenantId: "tenant-id",
      webhook: { port: 3979 },
      delegatedAuth: { enabled: true },
      enabled: true,
    });
    expect(saveDelegatedTokens).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: "access-token",
        refreshToken: "refresh-token",
      }),
      { accountId: "support" },
    );
    expect(progress.stop).toHaveBeenCalled();
  });
});
