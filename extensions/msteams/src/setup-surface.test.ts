import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/setup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMSTeamsSetupWizardBase,
  msteamsSetupAdapter,
  msteamsSetupContract,
} from "./setup-core.js";
import { createMSTeamsSetupPrompter, createMSTeamsTestConfig } from "./setup.test-support.js";

const hasConfiguredMSTeamsCredentials = vi.hoisted(() => vi.fn());
const resolveMSTeamsCredentials = vi.hoisted(() => vi.fn());

vi.mock("./token-config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./token-config.js")>()),
  hasConfiguredMSTeamsCredentials,
  resolveMSTeamsCredentials,
}));

describe("msteams setup surface", () => {
  const msteamsSetupWizard = createMSTeamsSetupWizardBase();

  beforeEach(() => {
    hasConfiguredMSTeamsCredentials.mockReset();
    resolveMSTeamsCredentials.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolves the requested account id", () => {
    expect(msteamsSetupAdapter.resolveAccountId?.({ cfg: {}, accountId: "work" })).toBe("work");
  });

  it("enables the msteams channel and promotes existing default identity", () => {
    expect(
      msteamsSetupAdapter.applyAccountConfig?.({
        cfg: createMSTeamsTestConfig({
          appId: "existing-app",
        }),
        accountId: DEFAULT_ACCOUNT_ID,
        input: {},
      }),
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

  it("updates an existing display-style account key in place", () => {
    const result = msteamsSetupAdapter.applyAccountConfig?.({
      cfg: createMSTeamsTestConfig({
        accounts: {
          "Support Bot": {
            name: "Support Bot",
            enabled: false,
            appId: "old-app",
            appPassword: "old-secret",
            tenantId: "old-tenant",
            webhook: { path: "/hooks/3979" },
          },
        },
      }),
      accountId: "support-bot",
      input: {
        appId: "support-app",
        appPassword: "support-secret",
        tenantId: "tenant-id",
      },
    });

    expect(result).toEqual({
      channels: {
        msteams: {
          enabled: true,
          accounts: {
            "Support Bot": {
              name: "Support Bot",
              enabled: true,
              appId: "support-app",
              appPassword: "support-secret",
              authType: "secret",
              tenantId: "tenant-id",
              webhook: { path: "/hooks/3979" },
            },
          },
        },
      },
    });
    expect(result?.channels?.msteams?.accounts).not.toHaveProperty("support-bot");
  });

  it("switches federated accounts to secret auth when noninteractive setup writes a password", () => {
    const result = msteamsSetupAdapter.applyAccountConfig?.({
      cfg: createMSTeamsTestConfig({
        tenantId: "tenant-id",
        accounts: {
          support: {
            authType: "federated",
            appId: "old-app",
            certificatePath: "/secure/support.pem",
            webhook: { path: "/hooks/3979" },
          },
        },
      }),
      accountId: "support",
      input: {
        appId: "new-app",
        appPassword: "new-password",
        tenantId: "tenant-id",
      },
    });

    const account = result?.channels?.msteams?.accounts?.support;
    expect(account).toMatchObject({
      authType: "secret",
      appId: "new-app",
      appPassword: "new-password",
    });
    expect(account?.certificatePath).toBeUndefined();
  });

  it("updates a display-style default alias without creating a duplicate key", () => {
    const result = msteamsSetupAdapter.applyAccountConfig?.({
      cfg: createMSTeamsTestConfig({
        tenantId: "tenant-id",
        accounts: {
          Default: {
            appId: "old-app",
            appPassword: "old-secret",
            webhook: { path: "/hooks/3978" },
          },
        },
      }),
      accountId: "default",
      input: {
        appId: "new-app",
        appPassword: "new-secret",
        tenantId: "tenant-id",
      },
    });

    expect(result?.channels?.msteams?.accounts).toEqual({
      Default: {
        enabled: true,
        appId: "new-app",
        appPassword: "new-secret",
        authType: "secret",
        webhook: { path: "/hooks/3978" },
        tenantId: "tenant-id",
      },
    });
    expect(result?.channels?.msteams?.accounts).not.toHaveProperty("default");
  });

  it("updates an explicit default account webhook path without changing the shared root", () => {
    const result = msteamsSetupAdapter.applyAccountConfig?.({
      cfg: createMSTeamsTestConfig({
        webhook: { path: "/root/messages" },
        accounts: {
          Default: {
            appId: "default-app",
            appPassword: "default-secret",
            tenantId: "tenant-id",
            webhook: { path: "/default/messages" },
          },
        },
      }),
      accountId: "default",
      input: { webhookPath: "/hooks/4978" },
    });

    expect(result?.channels?.msteams?.webhook).toEqual({ path: "/root/messages" });
    expect(result?.channels?.msteams?.accounts?.Default?.webhook).toEqual({
      path: "/hooks/4978",
    });
  });

  it("rejects env credentials for named accounts", () => {
    expect(
      msteamsSetupAdapter.validateInput?.({
        cfg: {},
        accountId: "support",
        input: { useEnv: true },
      }),
    ).toBe("MSTEAMS_* environment variables can only be used for the default account.");
  });

  it("allows a named account to use its derived webhook path", () => {
    const input = {
      appId: "support-app",
      appPassword: "support-secret",
      tenantId: "tenant-id",
    };
    expect(msteamsSetupContract.parseInput(input)).toEqual({ ok: true, value: input });
    expect(
      msteamsSetupContract.validateInput?.({
        cfg: createMSTeamsTestConfig({}),
        accountId: "support",
        input,
      }),
    ).toBeNull();
  });

  it("rejects whitespace-only noninteractive credentials", () => {
    expect(
      msteamsSetupContract.validateInput?.({
        cfg: createMSTeamsTestConfig({}),
        accountId: "default",
        input: { appId: " ", appPassword: "\t", tenantId: "\n" },
      }),
    ).toBe(
      "MS Teams requires appId, appPassword, and tenantId (or --use-env for the default account).",
    );
  });

  it("stores a webhook path supplied by noninteractive named-account setup", () => {
    const input = {
      appId: "support-app",
      appPassword: "support-secret",
      tenantId: "tenant-id",
      webhookPath: "/hooks/3979",
    };
    expect(
      msteamsSetupContract.validateInput?.({
        cfg: createMSTeamsTestConfig({}),
        accountId: "support",
        input,
      }),
    ).toBeNull();
    expect(
      msteamsSetupContract.applyAccountConfig({
        cfg: createMSTeamsTestConfig({}),
        accountId: "support",
        input,
      }).channels?.msteams?.accounts?.support,
    ).toEqual({
      enabled: true,
      appId: "support-app",
      appPassword: "support-secret",
      authType: "secret",
      tenantId: "tenant-id",
      webhook: { path: "/hooks/3979" },
    });
  });

  it("accepts new named-account credentials with an inherited root tenant", () => {
    const cfg = createMSTeamsTestConfig({
      tenantId: "shared-tenant",
      authType: "federated" as const,
      certificatePath: "/secure/shared.pem",
    });
    const input = {
      appId: "support-app",
      appPassword: "support-secret",
      webhookPath: "/hooks/3979",
    };
    hasConfiguredMSTeamsCredentials.mockImplementation(
      (candidate: { appId?: string; appPassword?: string; tenantId?: string }) =>
        Boolean(candidate.appId && candidate.appPassword && candidate.tenantId),
    );

    expect(
      msteamsSetupContract.validateInput?.({
        cfg,
        accountId: "support",
        input,
      }),
    ).toBeNull();
    expect(hasConfiguredMSTeamsCredentials).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: "support-app",
        appPassword: "support-secret",
        tenantId: "shared-tenant",
        authType: "secret",
      }),
      { allowEnvFallback: false },
    );
    expect(
      msteamsSetupContract.applyAccountConfig({
        cfg,
        accountId: "support",
        input,
      }).channels?.msteams?.accounts?.support,
    ).toEqual({
      enabled: true,
      appId: "support-app",
      appPassword: "support-secret",
      authType: "secret",
      webhook: { path: "/hooks/3979" },
    });
  });

  it("allows partial noninteractive updates for an already configured named account", () => {
    const cfg = createMSTeamsTestConfig({
      accounts: {
        support: {
          appId: "support-app",
          appPassword: "support-secret",
          tenantId: "tenant-id",
          webhook: { path: "/support/messages" },
        },
      },
    });
    resolveMSTeamsCredentials.mockReturnValue({
      type: "secret",
      appId: "support-app",
      appPassword: "support-secret",
      tenantId: "tenant-id",
    });
    hasConfiguredMSTeamsCredentials.mockReturnValue(true);

    expect(
      msteamsSetupContract.validateInput?.({
        cfg,
        accountId: "support",
        input: { webhookPath: "/hooks/3980" },
      }),
    ).toBeNull();
    expect(hasConfiguredMSTeamsCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ appId: "support-app" }),
      { allowEnvFallback: false },
    );
    expect(
      msteamsSetupContract.applyAccountConfig({
        cfg,
        accountId: "support",
        input: { webhookPath: "/hooks/3980" },
      }).channels?.msteams?.accounts?.support,
    ).toEqual({
      enabled: true,
      appId: "support-app",
      appPassword: "support-secret",
      tenantId: "tenant-id",
      webhook: { path: "/hooks/3980" },
    });
  });

  it("preserves federated auth during a partial noninteractive update", () => {
    const cfg = createMSTeamsTestConfig({
      accounts: {
        support: {
          authType: "federated" as const,
          appId: "support-app",
          tenantId: "tenant-id",
          certificatePath: "/secure/support.pem",
          webhook: { path: "/hooks/3979" },
        },
      },
    });
    resolveMSTeamsCredentials.mockReturnValue({
      type: "federated",
      appId: "support-app",
      tenantId: "tenant-id",
      certificatePath: "/secure/support.pem",
    });
    hasConfiguredMSTeamsCredentials.mockReturnValue(true);

    expect(
      msteamsSetupContract.validateInput?.({
        cfg,
        accountId: "support",
        input: { webhookPath: "/hooks/3980" },
      }),
    ).toBeNull();
    expect(
      msteamsSetupContract.applyAccountConfig({
        cfg,
        accountId: "support",
        input: { webhookPath: "/hooks/3980" },
      }).channels?.msteams?.accounts?.support,
    ).toEqual({
      enabled: true,
      authType: "federated",
      appId: "support-app",
      tenantId: "tenant-id",
      certificatePath: "/secure/support.pem",
      webhook: { path: "/hooks/3980" },
    });
  });

  it("re-enables a disabled named account when setup configures it", () => {
    expect(
      msteamsSetupAdapter.applyAccountConfig?.({
        cfg: createMSTeamsTestConfig({
          accounts: {
            support: {
              enabled: false,
              appId: "old-app",
            },
          },
        }),
        accountId: "support",
        input: {
          appId: "support-app",
          appPassword: "support-secret",
          tenantId: "tenant-id",
        },
      }),
    ).toEqual({
      channels: {
        msteams: {
          enabled: true,
          accounts: {
            support: {
              enabled: true,
              appId: "support-app",
              appPassword: "support-secret",
              authType: "secret",
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
        cfg: createMSTeamsTestConfig({}),
      } as never),
    ).toBe(true);
  });

  it("reports configured status from configured credentials and renders status lines", async () => {
    resolveMSTeamsCredentials.mockReturnValue(null);
    hasConfiguredMSTeamsCredentials.mockReturnValue(true);

    expect(
      msteamsSetupWizard.status.resolveConfigured({
        cfg: createMSTeamsTestConfig({}),
      } as never),
    ).toBe(true);

    hasConfiguredMSTeamsCredentials.mockReturnValue(false);
    expect(msteamsSetupWizard.status.resolveStatusLines).toBeTypeOf("function");
    await expect(
      msteamsSetupWizard.status.resolveStatusLines?.({
        cfg: createMSTeamsTestConfig({}),
      } as never),
    ).resolves.toEqual(["MS Teams: needs app credentials"]);
  });

  it("finalize keeps federated environment credentials when available and accepted", async () => {
    vi.stubEnv("MSTEAMS_AUTH_TYPE", "federated");
    vi.stubEnv("MSTEAMS_APP_ID", "env-app");
    vi.stubEnv("MSTEAMS_TENANT_ID", "env-tenant");
    vi.stubEnv("MSTEAMS_CERTIFICATE_PATH", "/secure/env.pem");
    resolveMSTeamsCredentials.mockReturnValue({
      type: "federated",
      appId: "env-app",
      tenantId: "env-tenant",
      certificatePath: "/secure/env.pem",
    });
    hasConfiguredMSTeamsCredentials.mockReturnValue(false);
    const prompter = createMSTeamsSetupPrompter();
    const { confirm } = prompter;

    const result = await msteamsSetupWizard.finalize?.({
      cfg: createMSTeamsTestConfig({}),
      prompter,
    } as never);

    expect(confirm).toHaveBeenCalledWith({
      message: "Microsoft Teams environment credentials detected. Use env vars?",
      initialValue: true,
    });
    expect(result?.cfg?.channels?.msteams).toEqual({
      enabled: true,
      accounts: { default: { enabled: true } },
    });
  });

  it("finalize keeps env credentials when available and accepted", async () => {
    vi.stubEnv("MSTEAMS_APP_ID", "env-app");
    vi.stubEnv("MSTEAMS_APP_PASSWORD", "env-secret");
    vi.stubEnv("MSTEAMS_TENANT_ID", "env-tenant");
    resolveMSTeamsCredentials.mockReturnValue({
      type: "secret",
      appId: "env-app",
      appPassword: "env-secret",
      tenantId: "env-tenant",
    });
    hasConfiguredMSTeamsCredentials.mockReturnValue(false);
    const prompter = createMSTeamsSetupPrompter();
    const { confirm } = prompter;

    const result = await msteamsSetupWizard.finalize?.({
      cfg: { channels: { msteams: { existing: true } } },
      prompter,
    } as never);

    expect(confirm).toHaveBeenCalledWith({
      message: "Microsoft Teams environment credentials detected. Use env vars?",
      initialValue: true,
    });
    expect(result).toEqual({
      accountId: "default",
      cfg: {
        channels: {
          msteams: {
            existing: true,
            enabled: true,
            accounts: { default: { enabled: true } },
          },
        },
      },
    });
  });

  it("finalize overrides federated environment auth when writing a new password", async () => {
    vi.stubEnv("MSTEAMS_AUTH_TYPE", "federated");
    vi.stubEnv("MSTEAMS_APP_ID", "env-app");
    vi.stubEnv("MSTEAMS_TENANT_ID", "env-tenant");
    vi.stubEnv("MSTEAMS_CERTIFICATE_PATH", "/secure/env.pem");
    resolveMSTeamsCredentials.mockReturnValue({
      type: "federated",
      appId: "env-app",
      tenantId: "env-tenant",
      certificatePath: "/secure/env.pem",
    });
    hasConfiguredMSTeamsCredentials.mockReturnValue(true);
    const prompter = createMSTeamsSetupPrompter(["new-app", "new-password", "new-tenant"]);

    const result = await msteamsSetupWizard.finalize?.({
      cfg: createMSTeamsTestConfig({}),
      accountId: "default",
      prompter,
    } as never);

    expect(result?.cfg?.channels?.msteams?.accounts?.default).toMatchObject({
      authType: "secret",
      appId: "new-app",
      appPassword: "new-password",
      tenantId: "new-tenant",
    });
  });

  it("finalize re-enables an account-scoped default when keeping its credentials", async () => {
    resolveMSTeamsCredentials.mockReturnValue({
      type: "secret",
      appId: "default-app",
      appPassword: "default-secret",
      tenantId: "tenant-id",
    });
    hasConfiguredMSTeamsCredentials.mockReturnValue(true);
    const prompter = createMSTeamsSetupPrompter();

    const result = await msteamsSetupWizard.finalize?.({
      cfg: createMSTeamsTestConfig({
        tenantId: "tenant-id",
        accounts: {
          Default: {
            enabled: false,
            appId: "default-app",
            appPassword: "default-secret",
            webhook: { path: "/hooks/3978" },
          },
        },
        defaultAccount: "Default",
      }),
      accountId: "default",
      prompter,
    } as never);

    if (!result?.cfg) {
      throw new Error("expected Teams setup result");
    }
    expect(result.cfg.channels?.msteams?.accounts?.Default?.enabled).toBe(true);
    expect(result.cfg.channels?.msteams?.accounts).not.toHaveProperty("default");
  });

  it.each([
    {
      label: "federated managed-identity env",
      env: {
        MSTEAMS_AUTH_TYPE: "federated",
        MSTEAMS_APP_ID: "env-app",
        MSTEAMS_TENANT_ID: "env-tenant",
        MSTEAMS_USE_MANAGED_IDENTITY: "true",
      },
      credentials: {
        type: "federated",
        appId: "env-app",
        tenantId: "env-tenant",
        useManagedIdentity: true,
      },
      msteams: {},
    },
    {
      label: "persisted secret",
      env: {},
      credentials: {
        type: "secret",
        appId: "stored-app",
        appPassword: "stored-password",
        tenantId: "stored-tenant",
      },
      msteams: {
        enabled: false,
        appId: "stored-app",
        appPassword: "stored-password",
        tenantId: "stored-tenant",
      },
    },
  ])(
    "finalize enables accepted $label credentials without rewriting them",
    async ({ env, credentials, msteams }) => {
      for (const [name, value] of Object.entries(env)) {
        vi.stubEnv(name, value);
      }
      resolveMSTeamsCredentials.mockReturnValue(credentials);
      hasConfiguredMSTeamsCredentials.mockReturnValue(true);
      const prompter = createMSTeamsSetupPrompter();
      const { confirm, text } = prompter;

      const result = await msteamsSetupWizard.finalize?.({
        cfg: { channels: { msteams } },
        prompter,
      } as never);

      expect(confirm).toHaveBeenCalledWith({
        message: "MS Teams credentials already configured. Keep them?",
        initialValue: true,
      });
      expect(text).not.toHaveBeenCalled();
      expect(result).toEqual({
        accountId: DEFAULT_ACCOUNT_ID,
        cfg: {
          channels: {
            msteams: {
              enabled: true,
              ...("tenantId" in msteams ? { tenantId: msteams.tenantId } : {}),
              accounts: {
                default: {
                  enabled: true,
                  ...("appId" in msteams
                    ? { appId: msteams.appId, appPassword: msteams.appPassword }
                    : {}),
                },
              },
            },
          },
        },
      });
    },
  );

  it("finalize prompts for manual credentials when env/config creds are unavailable", async () => {
    resolveMSTeamsCredentials.mockReturnValue(null);
    hasConfiguredMSTeamsCredentials.mockReturnValue(false);
    const prompter = createMSTeamsSetupPrompter(["app-id", "app-password", "tenant-id"]);
    const { note } = prompter;

    const result = await msteamsSetupWizard.finalize?.({
      cfg: createMSTeamsTestConfig({}),
      prompter,
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
                authType: "secret",
                tenantId: "tenant-id",
              },
            },
          },
        },
      },
    });
  });

  it("finalize configures named accounts with credentials without requiring a listener", async () => {
    resolveMSTeamsCredentials.mockReturnValue(null);
    hasConfiguredMSTeamsCredentials.mockReturnValue(false);
    const prompter = createMSTeamsSetupPrompter(["support-app", "support-password", "tenant-id"]);

    const result = await msteamsSetupWizard.finalize?.({
      cfg: createMSTeamsTestConfig({
        tenantId: "shared-tenant",
        webhook: { path: "/api/messages" },
        dmPolicy: "allowlist",
        allowFrom: ["user-1"],
      }),
      accountId: "support",
      prompter,
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
                authType: "secret",
                tenantId: "tenant-id",
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
    hasConfiguredMSTeamsCredentials.mockReturnValue(true);
    const prompter = createMSTeamsSetupPrompter();
    const { confirm, text } = prompter;

    const result = await msteamsSetupWizard.finalize?.({
      cfg: createMSTeamsTestConfig({
        accounts: {
          support: {
            authType: "federated",
            appId: "support-app",
            tenantId: "tenant-id",
            certificatePath: "/secure/support.pem",
            webhook: { path: "/hooks/3979" },
          },
        },
      }),
      accountId: "support",
      prompter,
    } as never);

    expect(result).toEqual({
      accountId: "support",
      cfg: {
        channels: {
          msteams: {
            enabled: true,
            accounts: {
              support: {
                authType: "federated",
                appId: "support-app",
                tenantId: "tenant-id",
                certificatePath: "/secure/support.pem",
                webhook: { path: "/hooks/3979" },
                enabled: true,
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

  it("finalize switches replaced federated credentials to secret auth", async () => {
    resolveMSTeamsCredentials.mockReturnValue({
      type: "federated",
      appId: "support-app",
      tenantId: "tenant-id",
      certificatePath: "/secure/support.pem",
    });
    hasConfiguredMSTeamsCredentials.mockReturnValue(false);
    const prompter = createMSTeamsSetupPrompter(["new-app", "new-password", "tenant-id"]);

    const result = await msteamsSetupWizard.finalize?.({
      cfg: createMSTeamsTestConfig({
        accounts: {
          support: {
            authType: "federated",
            appId: "support-app",
            tenantId: "tenant-id",
            certificatePath: "/secure/support.pem",
            webhook: { path: "/hooks/3979" },
          },
        },
      }),
      accountId: "support",
      prompter,
    } as never);

    if (!result?.cfg) {
      throw new Error("expected Teams setup result");
    }
    const account = result.cfg.channels?.msteams?.accounts?.support;
    expect(account).toMatchObject({
      authType: "secret",
      appId: "new-app",
      appPassword: "new-password",
    });
    expect(account?.certificatePath).toBeUndefined();
  });
});
