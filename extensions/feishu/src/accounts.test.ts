import { describe, expect, it, vi } from "vitest";
import {
  FeishuSecretRefUnavailableError,
  inspectFeishuCredentials,
  listFeishuAccountIds,
  resolveDefaultFeishuAccountId,
  resolveDefaultFeishuAccountSelection,
  resolveFeishuAccount,
  resolveFeishuCredentials,
  resolveFeishuOutboundCredentialsConfig,
  resolveFeishuRuntimeAccount,
} from "./accounts.js";
import type { FeishuConfig } from "./types.js";

// Emulate the gateway secret runtime: the async SDK resolver turns any SecretRef
// (env/file/exec/keychain) into a string. The sync feishu resolver cannot do this
// for exec/keychain sources, which is the #89338 failure the helper repairs.
const resolveConfiguredSecretInputStringMock = vi.hoisted(() =>
  vi.fn(async (params: { value: unknown }): Promise<{ value?: string }> => {
    const { value } = params;
    if (value && typeof value === "object" && "id" in value) {
      return { value: `resolved:${(value as { id?: string }).id ?? ""}` };
    }
    return { value: typeof value === "string" ? value : undefined };
  }),
);
vi.mock("openclaw/plugin-sdk/secret-input-runtime", () => ({
  resolveConfiguredSecretInputString: resolveConfiguredSecretInputStringMock,
}));

function makeDefaultAndRouterAccounts() {
  return {
    default: { appId: "cli_default", appSecret: "secret_default" }, // pragma: allowlist secret
    "router-d": { appId: "cli_router", appSecret: "secret_router" }, // pragma: allowlist secret
  };
}

function expectExplicitDefaultAccountSelection(
  account: ReturnType<typeof resolveFeishuAccount>,
  appId: string,
) {
  expect(account.accountId).toBe("router-d");
  expect(account.selectionSource).toBe("explicit-default");
  expect(account.configured).toBe(true);
  expect(account.appId).toBe(appId);
}

function withEnvVar(key: string, value: string | undefined, run: () => void) {
  const prev = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  try {
    run();
  } finally {
    if (prev === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prev;
    }
  }
}

function asConfig(config: Partial<FeishuConfig>): FeishuConfig {
  return config as unknown as FeishuConfig;
}

function expectUnresolvedEnvSecretRefError(key: string) {
  expect(() =>
    resolveFeishuCredentials(
      asConfig({
        appId: "cli_123",
        appSecret: { source: "env", provider: "default", id: key } as never,
      }),
    ),
  ).toThrow(/unresolved SecretRef/i);
}

describe("resolveDefaultFeishuAccountId", () => {
  it("preserves top-level default account when named accounts are configured", () => {
    const cfg = {
      channels: {
        feishu: {
          appId: "cli_default",
          appSecret: "secret_default",
          accounts: {
            work: { enabled: false },
          },
        },
      },
    };

    expect(listFeishuAccountIds(cfg as never)).toEqual(["default", "work"]);
    expect(resolveDefaultFeishuAccountId(cfg as never)).toBe("default");
  });

  it("prefers channels.feishu.defaultAccount when configured", () => {
    const cfg = {
      channels: {
        feishu: {
          defaultAccount: "router-d",
          accounts: makeDefaultAndRouterAccounts(),
        },
      },
    };

    expect(resolveDefaultFeishuAccountId(cfg as never)).toBe("router-d");
  });

  it("normalizes configured defaultAccount before lookup", () => {
    const cfg = {
      channels: {
        feishu: {
          defaultAccount: "Router D",
          accounts: {
            "router-d": { appId: "cli_router", appSecret: "secret_router" }, // pragma: allowlist secret
          },
        },
      },
    };

    expect(resolveDefaultFeishuAccountId(cfg as never)).toBe("router-d");
  });

  it("keeps configured defaultAccount even when not present in accounts map", () => {
    const cfg = {
      channels: {
        feishu: {
          defaultAccount: "router-d",
          accounts: {
            default: { appId: "cli_default", appSecret: "secret_default" }, // pragma: allowlist secret
            zeta: { appId: "cli_zeta", appSecret: "secret_zeta" }, // pragma: allowlist secret
          },
        },
      },
    };

    expect(resolveDefaultFeishuAccountId(cfg as never)).toBe("router-d");
  });

  it("falls back to literal default account id when present", () => {
    const cfg = {
      channels: {
        feishu: {
          accounts: {
            default: { appId: "cli_default", appSecret: "secret_default" }, // pragma: allowlist secret
            zeta: { appId: "cli_zeta", appSecret: "secret_zeta" }, // pragma: allowlist secret
          },
        },
      },
    };

    expect(resolveDefaultFeishuAccountId(cfg as never)).toBe("default");
  });

  it("reports selection source for configured defaults and mapped defaults", () => {
    const explicitDefaultCfg = {
      channels: {
        feishu: {
          defaultAccount: "router-d",
          accounts: {},
        },
      },
    };
    expect(resolveDefaultFeishuAccountSelection(explicitDefaultCfg as never)).toEqual({
      accountId: "router-d",
      source: "explicit-default",
    });

    const mappedDefaultCfg = {
      channels: {
        feishu: {
          accounts: {
            default: { appId: "cli_default", appSecret: "secret_default" }, // pragma: allowlist secret
          },
        },
      },
    };
    expect(resolveDefaultFeishuAccountSelection(mappedDefaultCfg as never)).toEqual({
      accountId: "default",
      source: "mapped-default",
    });
  });
});

describe("resolveFeishuCredentials", () => {
  it("throws unresolved SecretRef errors by default for unsupported secret sources", () => {
    expect(() =>
      resolveFeishuCredentials(
        asConfig({
          appId: "cli_123",
          appSecret: { source: "file", provider: "default", id: "path/to/secret" } as never,
        }),
      ),
    ).toThrow(/unresolved SecretRef/i);
  });

  it("returns null (without throwing) when unresolved SecretRef is allowed", () => {
    const creds = resolveFeishuCredentials(
      asConfig({
        appId: "cli_123",
        appSecret: { source: "file", provider: "default", id: "path/to/secret" } as never,
      }),
      { allowUnresolvedSecretRef: true },
    );

    expect(creds).toBeNull();
  });

  it("supports explicit inspect mode for unresolved SecretRefs", () => {
    const creds = resolveFeishuCredentials(
      asConfig({
        appId: "cli_123",
        appSecret: { source: "file", provider: "default", id: "path/to/secret" } as never,
      }),
      { mode: "inspect" },
    );

    expect(creds).toBeNull();
  });

  it("throws unresolved SecretRef error when env SecretRef points to missing env var", () => {
    const key = "FEISHU_APP_SECRET_MISSING_TEST";
    withEnvVar(key, undefined, () => {
      expectUnresolvedEnvSecretRefError(key);
    });
  });

  it("resolves env SecretRef objects when unresolved refs are allowed", () => {
    const key = "FEISHU_APP_SECRET_TEST";
    const prev = process.env[key];
    process.env[key] = " secret_from_env ";

    try {
      const creds = resolveFeishuCredentials(
        asConfig({
          appId: "cli_123",
          appSecret: { source: "env", provider: "default", id: key } as never,
        }),
        { allowUnresolvedSecretRef: true },
      );

      expect(creds).toEqual({
        appId: "cli_123",
        appSecret: "secret_from_env", // pragma: allowlist secret
        encryptKey: undefined,
        verificationToken: undefined,
        domain: "feishu",
      });
    } finally {
      if (prev === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = prev;
      }
    }
  });

  it("resolves env SecretRef with custom provider alias when unresolved refs are allowed", () => {
    const key = "FEISHU_APP_SECRET_CUSTOM_PROVIDER_TEST";
    const prev = process.env[key];
    process.env[key] = " secret_from_env_alias ";

    try {
      const creds = resolveFeishuCredentials(
        asConfig({
          appId: "cli_123",
          appSecret: { source: "env", provider: "corp-env", id: key } as never,
        }),
        { allowUnresolvedSecretRef: true },
      );

      expect(creds?.appSecret).toBe("secret_from_env_alias");
    } finally {
      if (prev === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = prev;
      }
    }
  });

  it("preserves unresolved SecretRef diagnostics for env refs in default mode", () => {
    const key = "FEISHU_APP_SECRET_POLICY_TEST";
    withEnvVar(key, "secret_from_env", () => {
      expectUnresolvedEnvSecretRefError(key);
    });
  });

  it("trims and returns credentials when values are valid strings", () => {
    const creds = resolveFeishuCredentials(
      asConfig({
        appId: " cli_123 ",
        appSecret: " secret_456 ",
        encryptKey: " enc ",
        verificationToken: " vt ",
      }),
    );

    expect(creds).toEqual({
      appId: "cli_123",
      appSecret: "secret_456", // pragma: allowlist secret
      encryptKey: "enc",
      verificationToken: "vt",
      domain: "feishu",
    });
  });

  it("does not resolve encryptKey SecretRefs outside webhook mode", () => {
    const creds = resolveFeishuCredentials(
      asConfig({
        connectionMode: "websocket",
        appId: "cli_123",
        appSecret: "secret_456",
        encryptKey: { source: "file", provider: "default", id: "path/to/secret" } as never,
      }),
    );

    expect(creds).toEqual({
      appId: "cli_123",
      appSecret: "secret_456", // pragma: allowlist secret
      encryptKey: undefined,
      verificationToken: undefined,
      domain: "feishu",
    });
  });

  it("keeps required credentials when optional event SecretRefs are unresolved in inspect mode", () => {
    const creds = inspectFeishuCredentials(
      asConfig({
        appId: "cli_123",
        appSecret: "secret_456",
        verificationToken: { source: "file", provider: "default", id: "path/to/token" } as never,
      }),
    );

    expect(creds).toEqual({
      appId: "cli_123",
      appSecret: "secret_456", // pragma: allowlist secret
      encryptKey: undefined,
      verificationToken: undefined,
      domain: "feishu",
    });
  });
});

describe("resolveFeishuAccount", () => {
  it("uses top-level credentials with configured default account id even without account map entry", () => {
    const cfg = {
      channels: {
        feishu: {
          defaultAccount: "router-d",
          appId: "top_level_app",
          appSecret: "top_level_secret", // pragma: allowlist secret
          accounts: {
            default: { appId: "cli_default", appSecret: "secret_default" }, // pragma: allowlist secret
          },
        },
      },
    };

    const account = resolveFeishuAccount({ cfg: cfg as never, accountId: undefined });
    expectExplicitDefaultAccountSelection(account, "top_level_app");
  });

  it("uses configured default account when accountId is omitted", () => {
    const cfg = {
      channels: {
        feishu: {
          defaultAccount: "router-d",
          accounts: {
            default: { enabled: true },
            "router-d": { appId: "cli_router", appSecret: "secret_router", enabled: true }, // pragma: allowlist secret
          },
        },
      },
    };

    const account = resolveFeishuAccount({ cfg: cfg as never, accountId: undefined });
    expectExplicitDefaultAccountSelection(account, "cli_router");
  });

  it("keeps explicit accountId selection", () => {
    const cfg = {
      channels: {
        feishu: {
          defaultAccount: "router-d",
          accounts: makeDefaultAndRouterAccounts(),
        },
      },
    };

    const account = resolveFeishuAccount({ cfg: cfg as never, accountId: "default" });
    expect(account.accountId).toBe("default");
    expect(account.selectionSource).toBe("explicit");
    expect(account.appId).toBe("cli_default");
  });

  it("treats unresolved SecretRef as not configured in account resolution", () => {
    const account = resolveFeishuAccount({
      cfg: {
        channels: {
          feishu: {
            accounts: {
              main: {
                appId: "cli_123",
                appSecret: { source: "file", provider: "default", id: "path/to/secret" },
              } as never,
            },
          },
        },
      } as never,
      accountId: "main",
    });
    expect(account.configured).toBe(false);
    expect(account.appSecret).toBeUndefined();
  });

  it("keeps account configured when optional event SecretRefs are unresolved in inspect mode", () => {
    const account = resolveFeishuAccount({
      cfg: {
        channels: {
          feishu: {
            accounts: {
              main: {
                appId: "cli_123",
                appSecret: "secret_456",
                verificationToken: {
                  source: "file",
                  provider: "default",
                  id: "path/to/token",
                },
              } as never,
            },
          },
        },
      } as never,
      accountId: "main",
    });

    expect(account.configured).toBe(true);
    expect(account.appSecret).toBe("secret_456");
    expect(account.verificationToken).toBeUndefined();
  });

  it("throws typed SecretRef errors in runtime account resolution", () => {
    let caught: unknown;
    try {
      resolveFeishuRuntimeAccount({
        cfg: {
          channels: {
            feishu: {
              accounts: {
                main: {
                  appId: "cli_123",
                  appSecret: { source: "file", provider: "default", id: "path/to/secret" },
                } as never,
              },
            },
          },
        } as never,
        accountId: "main",
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(FeishuSecretRefUnavailableError);
    expect((caught as Error).message).toMatch(/channels\.feishu\.appSecret: unresolved SecretRef/i);
  });

  it("ignores non-string account names", () => {
    const account = resolveFeishuAccount({
      cfg: {
        channels: {
          feishu: {
            accounts: {
              main: {
                name: { bad: true },
                appId: "cli_123",
                appSecret: "secret_456", // pragma: allowlist secret
              } as never,
            },
          },
        },
      } as never,
      accountId: "main",
    });

    expect(account.accountId).toBe("main");
    expect(account.appId).toBe("cli_123");
    expect(account.appSecret).toBe("secret_456");
    expect(account.name).toBeUndefined();
  });
});

describe("resolveFeishuOutboundCredentialsConfig (#89338)", () => {
  const execAppSecret = { source: "exec", provider: "keychain_feishu_main-bot", id: "value" };

  it("inlines an exec/keychain appSecret SecretRef so the runtime account resolves (no throw)", async () => {
    const cfg = {
      channels: {
        feishu: { accounts: { "main-bot": { appId: "cli_x", appSecret: execAppSecret } } },
      },
    } as never;

    // Before: the strict runtime resolver (media-upload path) throws on the unresolved ref.
    expect(() => resolveFeishuRuntimeAccount({ cfg, accountId: "main-bot" })).toThrow(
      FeishuSecretRefUnavailableError,
    );

    // After: the outbound helper inlines the resolved secret, so the same path succeeds.
    resolveConfiguredSecretInputStringMock.mockClear();
    const resolved = await resolveFeishuOutboundCredentialsConfig({ cfg, accountId: "main-bot" });
    const account = resolveFeishuRuntimeAccount({ cfg: resolved, accountId: "main-bot" });
    expect(account.configured).toBe(true);
    expect(account.appSecret).toBe("resolved:value");
    // Diagnostic path mirrors the matched account-map key, not the normalized id.
    expect(resolveConfiguredSecretInputStringMock).toHaveBeenCalledWith(
      expect.objectContaining({ path: "channels.feishu.accounts.main-bot.appSecret" }),
    );

    // Original config object is not mutated (the SecretRef stays on disk shape).
    expect(
      (
        cfg as unknown as {
          channels: { feishu: { accounts: Record<string, { appSecret: unknown }> } };
        }
      ).channels.feishu.accounts["main-bot"].appSecret,
    ).toEqual(execAppSecret);
  });

  it("resolves an inherited top-level appSecret SecretRef without inventing an accounts map", async () => {
    const cfg = {
      channels: { feishu: { appId: "cli_top", appSecret: execAppSecret } },
    } as never;
    resolveConfiguredSecretInputStringMock.mockClear();
    const resolved = (await resolveFeishuOutboundCredentialsConfig({ cfg })) as unknown as {
      channels: { feishu: { appSecret: unknown; accounts?: unknown } };
    };
    expect(resolved.channels.feishu.appSecret).toBe("resolved:value");
    expect(resolved.channels.feishu.accounts).toBeUndefined();
    // Inherited top-level secret: diagnostic path stays top-level, not account-shaped.
    expect(resolveConfiguredSecretInputStringMock).toHaveBeenCalledWith(
      expect.objectContaining({ path: "channels.feishu.appSecret" }),
    );
  });

  it("returns the same config (no clone) when credentials are plaintext", async () => {
    const cfg = {
      channels: { feishu: { accounts: { "main-bot": { appId: "cli_x", appSecret: "plain" } } } },
    } as never;
    const out = await resolveFeishuOutboundCredentialsConfig({ cfg, accountId: "main-bot" });
    expect(out).toBe(cfg);
  });

  it("preserves the matched noncanonical account-map key and its other per-account settings", async () => {
    const cfg = {
      channels: {
        feishu: {
          accounts: {
            "Main-Bot": { appId: "cli_x", appSecret: execAppSecret, renderMode: "card" },
          },
        },
      },
    } as never;
    const resolved = (await resolveFeishuOutboundCredentialsConfig({
      cfg,
      accountId: "main-bot",
    })) as unknown as {
      channels: {
        feishu: { accounts: Record<string, { appSecret: unknown; renderMode?: string }> };
      };
    };
    // The original mixed-case key is patched in place — no spurious normalized entry
    // that would shadow the original and drop its per-account settings.
    expect(Object.keys(resolved.channels.feishu.accounts)).toEqual(["Main-Bot"]);
    expect(resolved.channels.feishu.accounts["Main-Bot"].renderMode).toBe("card");
    expect(resolved.channels.feishu.accounts["Main-Bot"].appSecret).toBe("resolved:value");
  });
});
