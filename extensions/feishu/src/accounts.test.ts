// Feishu tests cover accounts plugin behavior.
import { withEnv } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import {
  FeishuSecretRefUnavailableError,
  listFeishuAccountIds,
  resolveDefaultFeishuAccountId,
  resolveDefaultFeishuAccountSelection,
  resolveFeishuAccount,
  resolveFeishuCredentials,
  resolveFeishuRuntimeAccount,
} from "./accounts.js";
import {
  FEISHU_SELECTED_SECRET_ENV,
  FEISHU_SIBLING_SECRET_ENV,
  createFeishuSecretRefPolicyConfig,
  createFeishuTestConfig,
  feishuSecretRefPolicyCases,
} from "./bot.test-support.js";
import type { FeishuConfig } from "./types.js";

function asConfig(config: Partial<FeishuConfig>): FeishuConfig {
  return config as unknown as FeishuConfig;
}

describe("resolveDefaultFeishuAccountId", () => {
  it("preserves top-level default account when named accounts are configured", () => {
    const cfg = createFeishuTestConfig({
      appId: "cli_default",
      appSecret: "secret_default",
      accounts: {
        work: { enabled: false },
      },
    });

    expect(listFeishuAccountIds(cfg)).toEqual(["default", "work"]);
    expect(resolveDefaultFeishuAccountId(cfg)).toBe("default");
  });

  it("reports selection source for configured defaults and mapped defaults", () => {
    const explicitDefaultCfg = createFeishuTestConfig({
      defaultAccount: "router-d",
      accounts: {},
    });
    expect(resolveDefaultFeishuAccountSelection(explicitDefaultCfg)).toEqual({
      accountId: "router-d",
      source: "explicit-default",
    });

    const mappedDefaultCfg = createFeishuTestConfig({
      accounts: {
        default: { appId: "cli_default", appSecret: "secret_default" }, // pragma: allowlist secret
      },
    });
    expect(resolveDefaultFeishuAccountSelection(mappedDefaultCfg)).toEqual({
      accountId: "default",
      source: "mapped-default",
    });
  });
});

describe("resolveFeishuCredentials", () => {
  it("resolves env SecretRef objects in inspect mode", () => {
    const key = "FEISHU_APP_SECRET_TEST";
    withEnv({ [key]: " secret_from_env " }, () => {
      const creds = resolveFeishuCredentials(
        asConfig({
          appId: "cli_123",
          appSecret: { source: "env", provider: "default", id: key } as never,
        }),
        { mode: "inspect" },
      );

      expect(creds).toEqual({
        appId: "cli_123",
        appSecret: "secret_from_env", // pragma: allowlist secret
        encryptKey: undefined,
        verificationToken: undefined,
        domain: "feishu",
      });
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
});

describe("resolveFeishuAccount", () => {
  it.each(["HtTpS"])(
    "normalizes only the %s scheme after account inheritance and selection",
    (scheme) => {
      const rootDomain = `${scheme}://Root.Example:8443/Root%2FPath/?tenant=Keep#Fragment`;
      const accountDomain = `${scheme}://fixture-user@Account.Example:9443/Account%2FPath/`;
      const cfg = createFeishuTestConfig({
        appId: "root-app",
        appSecret: "root-secret",
        domain: rootDomain,
        defaultAccount: "work",
        accounts: {
          inherited: {},
          work: { appId: "work-app", appSecret: "work-secret", domain: accountDomain },
        },
      });
      for (const resolveAccount of [resolveFeishuAccount, resolveFeishuRuntimeAccount]) {
        expect(resolveAccount({ cfg, accountId: "inherited" })).toMatchObject({
          accountId: "inherited",
          appId: "root-app",
          domain: "https://Root.Example:8443/Root%2FPath/?tenant=Keep#Fragment",
        });
        for (const accountId of [undefined, "work"]) {
          expect(resolveAccount({ cfg, accountId })).toMatchObject({
            accountId: "work",
            appId: "work-app",
            domain: "https://fixture-user@Account.Example:9443/Account%2FPath/",
          });
        }
      }
      expect(cfg).toMatchObject({
        channels: { feishu: { domain: rootDomain, accounts: { work: { domain: accountDomain } } } },
      });
    },
  );

  it.each(["encryptKey", "verificationToken"] as const)(
    "inspects webhook %s through the selected env collision without weakening strict mode",
    (field) => {
      withEnv({ [FEISHU_SELECTED_SECRET_ENV]: "event-secret" }, () => {
        const cfg = createFeishuTestConfig(
          {
            connectionMode: "webhook",
            appId: "app",
            appSecret: "app-secret",
            [field]: { source: "env", provider: "selected", id: FEISHU_SELECTED_SECRET_ENV },
          },
          {
            secrets: {
              defaults: { env: "selected" },
              providers: { selected: { source: "exec", command: "/unused" } },
            },
          },
        );
        expect(() => resolveFeishuRuntimeAccount({ cfg }, { requireEventSecrets: true })).toThrow(
          FeishuSecretRefUnavailableError,
        );
        expect(resolveFeishuAccount({ cfg })[field]).toBe("event-secret");
        expect(resolveFeishuRuntimeAccount({ cfg })[field]).toBe("event-secret");
      });
    },
  );

  it.each(
    feishuSecretRefPolicyCases.filter(({ name }) =>
      [
        "unconfigured provider alias",
        "provider configured with a non-env source",
        "provider allowlist excluding the selected credential",
        "selected env default shadowing an exec provider",
      ].includes(name),
    ),
  )("enforces read-only provider policy for $name", (testCase) => {
    withEnv({ [FEISHU_SELECTED_SECRET_ENV]: " selected-secret " }, () => {
      withEnv({ [FEISHU_SIBLING_SECRET_ENV]: "sibling-secret" }, () => {
        const account = resolveFeishuAccount({
          cfg: createFeishuSecretRefPolicyConfig(testCase),
          accountId: "selected",
        });

        expect(account.accountId).toBe("selected");
        expect(account.configured).toBe(testCase.configured);
        expect(account.appId).toBe(testCase.configured ? "selected-app" : undefined);
        expect(account.appSecret).toBe(testCase.configured ? "selected-secret" : undefined);
      });
    });
  });

  it("keeps account configured when optional event SecretRefs are unresolved in inspect mode", () => {
    const account = resolveFeishuAccount({
      cfg: createFeishuTestConfig({
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
      }),
      accountId: "main",
    });

    expect(account.configured).toBe(true);
    expect(account.appSecret).toBe("secret_456");
    expect(account.verificationToken).toBeUndefined();
  });

  it("does not resolve ambient env refs in strict runtime account snapshots", () => {
    withEnv({ [FEISHU_SELECTED_SECRET_ENV]: "selected-secret" }, () => {
      expect(() =>
        resolveFeishuRuntimeAccount({
          cfg: createFeishuTestConfig({
            appId: "selected-app",
            appSecret: { source: "env", provider: "default", id: FEISHU_SELECTED_SECRET_ENV },
          }),
        }),
      ).toThrow(FeishuSecretRefUnavailableError);
    });
  });
});
