import type { MSTeamsConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, expect, it, vi } from "vitest";
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
function identities(accounts: MSTeamsConfig["accounts"], root: MSTeamsConfig = {}): MSTeamsConfig {
  return { tenantId: "tenant-id", ...root, accounts };
}
const sibling = (appId: string, path: string, enabled = true) =>
  account({ appId, webhook: { path }, enabled });
const expectValid = (config: unknown, valid: boolean) =>
  expect(MSTeamsConfigSchema.safeParse(config).success).toBe(valid);

afterEach(() => vi.unstubAllEnvs());

it.each([
  [
    "SSO inheritance",
    named({ sso: { enabled: true } }, { sso: { connectionName: "graph" } }),
    true,
  ],
  [
    "SSO empty override",
    named({ sso: { connectionName: "" } }, { sso: { enabled: true, connectionName: "graph" } }),
    false,
  ],
  ["missing tenant", named({}, { tenantId: undefined }), false],
  ["blank secret", named({ appPassword: "   " }), false],
  ["federation without identity", named({ authType: "federated", appPassword: undefined }), false],
  [
    "disabled duplicate route",
    identities({
      default: sibling("primary-app-id", "/hooks/3978"),
      secondary: sibling("secondary-app-id", "/hooks/3978", false),
    }),
    true,
  ],
  [
    "logical id matching appId",
    named({}, { appId: "support", appPassword: "primary-secret" }),
    true,
  ],
  [
    "inherited certificate",
    named(
      { appPassword: undefined },
      {
        authType: "federated",
        certificatePath: "/secure/secondary.pem",
      },
    ),
    true,
  ],
  ["unsupported host", { cloud: "USGovDoD", serviceUrl: "https://dod.example.mil/teams" }, false],
  [
    "China with public host",
    { cloud: "China", serviceUrl: "https://smba.trafficmanager.net/teams" },
    false,
  ],
  ["public with China host", { serviceUrl: "https://msteams.botframework.azure.cn/teams" }, false],
  ["non-public without URL", { cloud: "USGov" }, false],
] as const)("validates %s", (_name, config, valid) => expectValid(config, valid));

it.each([
  [
    "canonical account id",
    identities(
      {
        "Support Bot": account(),
        "support-bot": sibling("support-shadow-app-id", "/hooks/3980"),
      },
      { webhook: { path: "/api/messages" } },
    ),
    "support-bot",
    'duplicate canonical account id "support-bot"',
  ],
  [
    "root/default identity",
    identities(
      {
        Default: sibling("default-app-id", "/hooks/3978"),
      },
      { appId: "root-app-id", appPassword: "root-secret" },
    ),
    "Default",
    "default Teams identity",
  ],
] as const)("rejects conflicting %s", (_name, config, key, message) => {
  const result = MSTeamsConfigSchema.safeParse(config);
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues).toContainEqual(
      expect.objectContaining({
        path: ["accounts", key],
        message: expect.stringContaining(message),
      }),
    );
  }
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
      {
        tenantId: "shared-tenant-id",
        webhook: { path: "/hooks/3980" },
      },
    ),
    false,
  );
});
