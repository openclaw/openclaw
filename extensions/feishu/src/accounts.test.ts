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

const credentials = { appId: "cli_123", appSecret: "secret_456" };
const resolvedCredentials = {
  ...credentials,
  encryptKey: undefined,
  verificationToken: undefined,
  domain: "feishu",
};
const envRef = (provider = "default") => ({
  source: "env" as const,
  provider,
  id: FEISHU_SELECTED_SECRET_ENV,
});

describe("Feishu account resolution", () => {
  it("preserves top-level default account when named accounts are configured", () => {
    const cfg = createFeishuTestConfig({
      ...credentials,
      accounts: { work: { enabled: false } },
    });

    expect(listFeishuAccountIds(cfg)).toEqual(["default", "work"]);
    expect(resolveDefaultFeishuAccountId(cfg)).toBe("default");
  });

  it.each([
    [{ defaultAccount: "router-d", accounts: {} }, "router-d", "explicit-default"],
    [{ accounts: { default: credentials } }, "default", "mapped-default"],
  ] as const)("reports selection source for %j", (config, accountId, source) => {
    const cfg = createFeishuTestConfig(config);
    expect(resolveDefaultFeishuAccountSelection(cfg)).toEqual({ accountId, source });
  });
  it("resolves env SecretRef objects in inspect mode", () => {
    withEnv({ [FEISHU_SELECTED_SECRET_ENV]: " secret_from_env " }, () => {
      const cfg = asConfig({ ...credentials, appSecret: envRef() as never });
      expect(resolveFeishuCredentials(cfg, { mode: "inspect" })).toEqual({
        ...resolvedCredentials,
        appSecret: "secret_from_env", // pragma: allowlist secret
      });
    });
  });

  it("does not resolve encryptKey SecretRefs outside webhook mode", () => {
    const cfg = asConfig({
      ...credentials,
      connectionMode: "websocket",
      encryptKey: { source: "file", provider: "default", id: "path/to/secret" } as never,
    });
    expect(resolveFeishuCredentials(cfg)).toEqual(resolvedCredentials);
  });
  it("normalizes only the scheme after account inheritance and selection", () => {
    const rootDomain = "HtTpS://Root.Example:8443/R%2FP/?q=K#F";
    const accountDomain = "HtTpS://u@Account.Example:9443/A%2FP/";
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
    const selections = [
      ["inherited", "inherited", "root-app", "https://Root.Example:8443/R%2FP/?q=K#F"],
      [undefined, "work", "work-app", "https://u@Account.Example:9443/A%2FP/"],
      ["work", "work", "work-app", "https://u@Account.Example:9443/A%2FP/"],
    ] as const;
    for (const resolve of [resolveFeishuAccount, resolveFeishuRuntimeAccount]) {
      for (const [selected, accountId, appId, domain] of selections) {
        expect(resolve({ cfg, accountId: selected })).toMatchObject({ accountId, appId, domain });
      }
    }
    expect(cfg).toMatchObject({
      channels: { feishu: { domain: rootDomain, accounts: { work: { domain: accountDomain } } } },
    });
  });

  it.each(["encryptKey", "verificationToken"] as const)("checks webhook %s authority", (field) => {
    withEnv({ [FEISHU_SELECTED_SECRET_ENV]: "event-secret" }, () => {
      const secrets = {
        defaults: { env: "selected" },
        providers: { selected: { source: "exec" as const, command: "/unused" } },
      };
      const cfg = createFeishuTestConfig(
        {
          ...credentials,
          connectionMode: "webhook",
          [field]: envRef("selected"),
        },
        { secrets },
      );
      expect(() => resolveFeishuRuntimeAccount({ cfg }, { requireEventSecrets: true })).toThrow(
        FeishuSecretRefUnavailableError,
      );
      expect(resolveFeishuAccount({ cfg })[field]).toBe("event-secret");
      expect(resolveFeishuRuntimeAccount({ cfg })[field]).toBe("event-secret");
    });
  });

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
    const env = {
      [FEISHU_SELECTED_SECRET_ENV]: " selected-secret ",
      [FEISHU_SIBLING_SECRET_ENV]: "sibling-secret",
    };
    withEnv(env, () => {
      const cfg = createFeishuSecretRefPolicyConfig(testCase);
      const account = resolveFeishuAccount({ cfg, accountId: "selected" });

      expect(account).toMatchObject({
        accountId: "selected",
        configured: testCase.configured,
        appId: testCase.configured ? "selected-app" : undefined,
        appSecret: testCase.configured ? "selected-secret" : undefined,
      });
    });
  });

  it("keeps account configured when optional event SecretRefs are unresolved in inspect mode", () => {
    const main = {
      ...credentials,
      verificationToken: { source: "file", provider: "default", id: "path/to/token" },
    } as never;
    const cfg = createFeishuTestConfig({ accounts: { main } });
    expect(resolveFeishuAccount({ cfg, accountId: "main" })).toMatchObject({
      configured: true,
      appSecret: "secret_456",
      verificationToken: undefined,
    });
  });

  it("does not resolve ambient env refs in strict runtime account snapshots", () => {
    withEnv({ [FEISHU_SELECTED_SECRET_ENV]: "selected-secret" }, () => {
      const cfg = createFeishuTestConfig({ appId: "selected-app", appSecret: envRef() });
      expect(() => resolveFeishuRuntimeAccount({ cfg })).toThrow(FeishuSecretRefUnavailableError);
    });
  });
});
