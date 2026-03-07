import { describe, expect, it } from "vitest";
import {
  resolveDefaultFeishuAccountId,
  resolveDefaultFeishuAccountSelection,
  resolveFeishuAccount,
  resolveFeishuCredentials,
} from "./accounts.js";
import type { FeishuConfig } from "./types.js";

const asConfig = (value: Partial<FeishuConfig>) => value as FeishuConfig;

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
  it("prefers channels.feishu.defaultAccount when configured", () => {
    const cfg = {
      channels: {
        feishu: {
          defaultAccount: "router-d",
          accounts: {
            default: { appId: "cli_default", appSecret: "secret_default" }, // pragma: allowlist secret
            "router-d": { appId: "cli_router", appSecret: "secret_router" }, // pragma: allowlist secret
          },
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
    expect(account.accountId).toBe("router-d");
    expect(account.selectionSource).toBe("explicit-default");
    expect(account.configured).toBe(true);
    expect(account.appId).toBe("top_level_app");
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
    expect(account.accountId).toBe("router-d");
    expect(account.selectionSource).toBe("explicit-default");
    expect(account.configured).toBe(true);
    expect(account.appId).toBe("cli_router");
  });

  it("keeps explicit accountId selection", () => {
    const cfg = {
      channels: {
        feishu: {
          defaultAccount: "router-d",
          accounts: {
            default: { appId: "cli_default", appSecret: "secret_default" }, // pragma: allowlist secret
            "router-d": { appId: "cli_router", appSecret: "secret_router" }, // pragma: allowlist secret
          },
        },
      },
    };

    const account = resolveFeishuAccount({ cfg: cfg as never, accountId: "default" });
    expect(account.accountId).toBe("default");
    expect(account.selectionSource).toBe("explicit");
    expect(account.appId).toBe("cli_default");
  });

  it("surfaces unresolved SecretRef errors in account resolution", () => {
    expect(() =>
      resolveFeishuAccount({
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
      }),
    ).toThrow(/unresolved SecretRef/i);
  });

  it("does not throw when account name is non-string", () => {
    expect(() =>
      resolveFeishuAccount({
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
      }),
    ).not.toThrow();
  });
});
