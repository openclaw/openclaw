import type { MSTeamsConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MSTeamsConfigSchema } from "../config-api.js";

function account(overrides: MSTeamsConfig = {}): MSTeamsConfig {
  return {
    appId: "support-app-id",
    appPassword: "support-secret",
    webhook: { path: "/hooks/3979" },
    ...overrides,
  };
}
function named(overrides: MSTeamsConfig = {}, root: MSTeamsConfig = {}): MSTeamsConfig {
  return { tenantId: "tenant-id", accounts: { support: account(overrides) }, ...root };
}
function expectValid(config: unknown, valid: boolean) {
  expect(MSTeamsConfigSchema.safeParse(config).success).toBe(valid);
}
function expectIssue(config: MSTeamsConfig, key: string, message: string) {
  const result = MSTeamsConfigSchema.safeParse(config);
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ["accounts", key],
          message: expect.stringContaining(message),
        }),
      ]),
    );
  }
}

describe("msteams config schema", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("validates named SSO after merging root and account settings", () => {
    expectValid(named({ sso: { enabled: true } }, { sso: { connectionName: "graph" } }), true);
    expectValid(
      named({ sso: { connectionName: "" } }, { sso: { enabled: true, connectionName: "graph" } }),
      false,
    );
  });

  it("does not reserve a partial environment default app ID", () => {
    vi.stubEnv("MSTEAMS_APP_ID", "support-app-id");
    expectValid(named(), true);
  });

  it("honors a managed identity opt-out when detecting an environment default", () => {
    vi.stubEnv("MSTEAMS_APP_ID", "support-app-id");
    vi.stubEnv("MSTEAMS_TENANT_ID", "environment-tenant-id");
    vi.stubEnv("MSTEAMS_AUTH_TYPE", "federated");
    vi.stubEnv("MSTEAMS_USE_MANAGED_IDENTITY", "true");
    expectValid(named({ webhook: { path: "/hooks/3978" } }, { useManagedIdentity: false }), true);
  });

  it("rejects named Teams bot accounts with duplicate canonical account ids", () => {
    expectIssue(
      {
        tenantId: "tenant-id",
        webhook: { path: "/api/messages" },
        accounts: {
          "Support Bot": account(),
          "support-bot": account({
            appId: "support-shadow-app-id",
            appPassword: "support-shadow-secret",
            webhook: { path: "/hooks/3980" },
          }),
        },
      },
      "support-bot",
      'duplicate canonical account id "support-bot"',
    );
  });

  it("rejects simultaneous root and canonical default account alias identity definitions", () => {
    expectIssue(
      {
        appId: "root-app-id",
        appPassword: "root-secret",
        tenantId: "tenant-id",
        accounts: {
          Default: account({
            appId: "default-app-id",
            appPassword: "default-secret",
            webhook: { path: "/hooks/3978" },
          }),
        },
      },
      "Default",
      "default Teams identity",
    );
  });

  it("rejects named accounts that collide with an environment-backed default route", () => {
    vi.stubEnv("MSTEAMS_APP_ID", "env-default-app");
    vi.stubEnv("MSTEAMS_APP_PASSWORD", "env-default-password");
    vi.stubEnv("MSTEAMS_TENANT_ID", "env-tenant-id");
    expectValid(
      named({ webhook: { path: "/api/messages" } }, { tenantId: "shared-tenant-id" }),
      false,
    );
    expectValid(
      named(
        { appId: "env-default-app" },
        { tenantId: "shared-tenant-id", webhook: { path: "/hooks/3980" } },
      ),
      false,
    );
  });

  it.each([
    ["missing tenant ID", named({}, { tenantId: undefined })],
    ["whitespace-only secret", named({ appPassword: "   " })],
    [
      "federation without a certificate or managed identity",
      named({ authType: "federated", appPassword: undefined }),
    ],
  ])("rejects enabled named accounts with %s", (_name, config) => {
    expectValid(config, false);
  });

  it("allows duplicate webhook paths when one account is disabled", () => {
    expectValid(
      {
        tenantId: "tenant-id",
        accounts: {
          default: account({
            appId: "primary-app-id",
            appPassword: "primary-secret",
            webhook: { path: "/hooks/3978" },
          }),
          secondary: account({
            enabled: false,
            appId: "secondary-app-id",
            appPassword: "secondary-secret",
            webhook: { path: "/hooks/3978" },
          }),
        },
      },
      true,
    );
  });

  it("allows an enabled logical account id matching another bot's appId", () => {
    expectValid(named({}, { appId: "support", appPassword: "primary-secret" }), true);
  });

  it("accepts enabled named federated accounts with inherited certificate config", () => {
    expectValid(
      named(
        { appPassword: undefined },
        { authType: "federated", certificatePath: "/secure/secondary.pem" },
      ),
      true,
    );
  });

  it.each([
    [
      "unsupported Teams serviceUrl hosts",
      { cloud: "USGovDoD", serviceUrl: "https://dod.example.mil/teams" },
    ],
    [
      "non-China hosts in China cloud",
      { cloud: "China", serviceUrl: "https://smba.trafficmanager.net/teams" },
    ],
    [
      "China hosts outside China cloud",
      { serviceUrl: "https://msteams.botframework.azure.cn/teams" },
    ],
    ["non-public clouds without serviceUrl", { cloud: "USGov" }],
  ])("rejects %s", (_name, config) => {
    expectValid(config, false);
  });
});
