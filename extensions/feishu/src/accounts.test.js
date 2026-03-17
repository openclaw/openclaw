import { describe, expect, it } from "vitest";
import {
  resolveDefaultFeishuAccountId,
  resolveDefaultFeishuAccountSelection,
  resolveFeishuAccount,
  resolveFeishuCredentials
} from "./accounts.js";
const asConfig = (value) => value;
function makeDefaultAndRouterAccounts() {
  return {
    default: { appId: "cli_default", appSecret: "secret_default" },
    // pragma: allowlist secret
    "router-d": { appId: "cli_router", appSecret: "secret_router" }
    // pragma: allowlist secret
  };
}
function expectExplicitDefaultAccountSelection(account, appId) {
  expect(account.accountId).toBe("router-d");
  expect(account.selectionSource).toBe("explicit-default");
  expect(account.configured).toBe(true);
  expect(account.appId).toBe(appId);
}
function withEnvVar(key, value, run) {
  const prev = process.env[key];
  if (value === void 0) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  try {
    run();
  } finally {
    if (prev === void 0) {
      delete process.env[key];
    } else {
      process.env[key] = prev;
    }
  }
}
function expectUnresolvedEnvSecretRefError(key) {
  expect(
    () => resolveFeishuCredentials(
      asConfig({
        appId: "cli_123",
        appSecret: { source: "env", provider: "default", id: key }
      })
    )
  ).toThrow(/unresolved SecretRef/i);
}
describe("resolveDefaultFeishuAccountId", () => {
  it("prefers channels.feishu.defaultAccount when configured", () => {
    const cfg = {
      channels: {
        feishu: {
          defaultAccount: "router-d",
          accounts: makeDefaultAndRouterAccounts()
        }
      }
    };
    expect(resolveDefaultFeishuAccountId(cfg)).toBe("router-d");
  });
  it("normalizes configured defaultAccount before lookup", () => {
    const cfg = {
      channels: {
        feishu: {
          defaultAccount: "Router D",
          accounts: {
            "router-d": { appId: "cli_router", appSecret: "secret_router" }
            // pragma: allowlist secret
          }
        }
      }
    };
    expect(resolveDefaultFeishuAccountId(cfg)).toBe("router-d");
  });
  it("keeps configured defaultAccount even when not present in accounts map", () => {
    const cfg = {
      channels: {
        feishu: {
          defaultAccount: "router-d",
          accounts: {
            default: { appId: "cli_default", appSecret: "secret_default" },
            // pragma: allowlist secret
            zeta: { appId: "cli_zeta", appSecret: "secret_zeta" }
            // pragma: allowlist secret
          }
        }
      }
    };
    expect(resolveDefaultFeishuAccountId(cfg)).toBe("router-d");
  });
  it("falls back to literal default account id when present", () => {
    const cfg = {
      channels: {
        feishu: {
          accounts: {
            default: { appId: "cli_default", appSecret: "secret_default" },
            // pragma: allowlist secret
            zeta: { appId: "cli_zeta", appSecret: "secret_zeta" }
            // pragma: allowlist secret
          }
        }
      }
    };
    expect(resolveDefaultFeishuAccountId(cfg)).toBe("default");
  });
  it("reports selection source for configured defaults and mapped defaults", () => {
    const explicitDefaultCfg = {
      channels: {
        feishu: {
          defaultAccount: "router-d",
          accounts: {}
        }
      }
    };
    expect(resolveDefaultFeishuAccountSelection(explicitDefaultCfg)).toEqual({
      accountId: "router-d",
      source: "explicit-default"
    });
    const mappedDefaultCfg = {
      channels: {
        feishu: {
          accounts: {
            default: { appId: "cli_default", appSecret: "secret_default" }
            // pragma: allowlist secret
          }
        }
      }
    };
    expect(resolveDefaultFeishuAccountSelection(mappedDefaultCfg)).toEqual({
      accountId: "default",
      source: "mapped-default"
    });
  });
});
describe("resolveFeishuCredentials", () => {
  it("throws unresolved SecretRef errors by default for unsupported secret sources", () => {
    expect(
      () => resolveFeishuCredentials(
        asConfig({
          appId: "cli_123",
          appSecret: { source: "file", provider: "default", id: "path/to/secret" }
        })
      )
    ).toThrow(/unresolved SecretRef/i);
  });
  it("returns null (without throwing) when unresolved SecretRef is allowed", () => {
    const creds = resolveFeishuCredentials(
      asConfig({
        appId: "cli_123",
        appSecret: { source: "file", provider: "default", id: "path/to/secret" }
      }),
      { allowUnresolvedSecretRef: true }
    );
    expect(creds).toBeNull();
  });
  it("throws unresolved SecretRef error when env SecretRef points to missing env var", () => {
    const key = "FEISHU_APP_SECRET_MISSING_TEST";
    withEnvVar(key, void 0, () => {
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
          appSecret: { source: "env", provider: "default", id: key }
        }),
        { allowUnresolvedSecretRef: true }
      );
      expect(creds).toEqual({
        appId: "cli_123",
        appSecret: "secret_from_env",
        // pragma: allowlist secret
        encryptKey: void 0,
        verificationToken: void 0,
        domain: "feishu"
      });
    } finally {
      if (prev === void 0) {
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
          appSecret: { source: "env", provider: "corp-env", id: key }
        }),
        { allowUnresolvedSecretRef: true }
      );
      expect(creds?.appSecret).toBe("secret_from_env_alias");
    } finally {
      if (prev === void 0) {
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
        verificationToken: " vt "
      })
    );
    expect(creds).toEqual({
      appId: "cli_123",
      appSecret: "secret_456",
      // pragma: allowlist secret
      encryptKey: "enc",
      verificationToken: "vt",
      domain: "feishu"
    });
  });
  it("does not resolve encryptKey SecretRefs outside webhook mode", () => {
    const creds = resolveFeishuCredentials(
      asConfig({
        connectionMode: "websocket",
        appId: "cli_123",
        appSecret: "secret_456",
        encryptKey: { source: "file", provider: "default", id: "path/to/secret" }
      })
    );
    expect(creds).toEqual({
      appId: "cli_123",
      appSecret: "secret_456",
      // pragma: allowlist secret
      encryptKey: void 0,
      verificationToken: void 0,
      domain: "feishu"
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
          appSecret: "top_level_secret",
          // pragma: allowlist secret
          accounts: {
            default: { appId: "cli_default", appSecret: "secret_default" }
            // pragma: allowlist secret
          }
        }
      }
    };
    const account = resolveFeishuAccount({ cfg, accountId: void 0 });
    expectExplicitDefaultAccountSelection(account, "top_level_app");
  });
  it("uses configured default account when accountId is omitted", () => {
    const cfg = {
      channels: {
        feishu: {
          defaultAccount: "router-d",
          accounts: {
            default: { enabled: true },
            "router-d": { appId: "cli_router", appSecret: "secret_router", enabled: true }
            // pragma: allowlist secret
          }
        }
      }
    };
    const account = resolveFeishuAccount({ cfg, accountId: void 0 });
    expectExplicitDefaultAccountSelection(account, "cli_router");
  });
  it("keeps explicit accountId selection", () => {
    const cfg = {
      channels: {
        feishu: {
          defaultAccount: "router-d",
          accounts: makeDefaultAndRouterAccounts()
        }
      }
    };
    const account = resolveFeishuAccount({ cfg, accountId: "default" });
    expect(account.accountId).toBe("default");
    expect(account.selectionSource).toBe("explicit");
    expect(account.appId).toBe("cli_default");
  });
  it("surfaces unresolved SecretRef errors in account resolution", () => {
    expect(
      () => resolveFeishuAccount({
        cfg: {
          channels: {
            feishu: {
              accounts: {
                main: {
                  appId: "cli_123",
                  appSecret: { source: "file", provider: "default", id: "path/to/secret" }
                }
              }
            }
          }
        },
        accountId: "main"
      })
    ).toThrow(/unresolved SecretRef/i);
  });
  it("does not throw when account name is non-string", () => {
    expect(
      () => resolveFeishuAccount({
        cfg: {
          channels: {
            feishu: {
              accounts: {
                main: {
                  name: { bad: true },
                  appId: "cli_123",
                  appSecret: "secret_456"
                  // pragma: allowlist secret
                }
              }
            }
          }
        },
        accountId: "main"
      })
    ).not.toThrow();
  });
});
