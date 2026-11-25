import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveMSTeamsAccount } from "./accounts.js";
import { msteamsConfigAdapter } from "./channel-config.js";

const identity = (name: string) => ({ appId: `${name}-app`, appPassword: `${name}-secret` });
function config(
  overrides: NonNullable<NonNullable<OpenClawConfig["channels"]>["msteams"]>,
): OpenClawConfig {
  return { channels: { msteams: { tenantId: "tenant-id", ...overrides } } };
}
const account = (cfg: OpenClawConfig, accountId = "default") =>
  resolveMSTeamsAccount({ cfg, accountId });
const expectAccount = (cfg: OpenClawConfig, accountId: string, enabled: boolean) =>
  expect(account(cfg, accountId)).toMatchObject({ enabled, configured: true });

describe("msteams account config mutations", () => {
  afterEach(() => vi.unstubAllEnvs());
  it.each([false, true])("sets legacy default enabled=%s without affecting siblings", (enabled) => {
    const cfg = config(
      enabled
        ? { enabled: false, ...identity("legacy") }
        : { ...identity("legacy"), accounts: { support: identity("support") } },
    );
    const updated = msteamsConfigAdapter.setAccountEnabled({
      cfg,
      accountId: "default",
      enabled,
    });
    expect(updated.channels?.msteams?.enabled).toBe(enabled || undefined);
    expect(account(updated)).toMatchObject({
      enabled,
      configured: true,
      config: { appId: "legacy-app" },
    });
    if (!enabled) {
      expectAccount(updated, "support", true);
    }
  });

  it.each(["alpha", "default"])("selects %s after deleting the named default", (selected) => {
    const cfg = config({
      ...(selected === "default" ? identity("legacy") : {}),
      defaultAccount: "support",
      accounts: {
        support: identity("support"),
        ...(selected === "alpha" ? { zeta: identity("zeta"), alpha: identity("alpha") } : {}),
      },
    });
    const updated = msteamsConfigAdapter.deleteAccount({ cfg, accountId: "support" });
    expect(updated.channels?.msteams?.defaultAccount).toBeUndefined();
    expect(resolveMSTeamsAccount({ cfg: updated })).toMatchObject({
      accountId: selected,
      configured: true,
    });
    if (selected === "default") {
      expect(updated.channels?.msteams?.accounts).toBeUndefined();
    }
  });

  it.each(["root", "environment-only"] as const)(
    "keeps a deleted %s default disabled despite complete environment credentials",
    (storage) => {
      vi.stubEnv("MSTEAMS_APP_ID", "env-app");
      vi.stubEnv("MSTEAMS_APP_PASSWORD", "env-secret");
      vi.stubEnv("MSTEAMS_TENANT_ID", "env-tenant");
      vi.stubEnv("MSTEAMS_AUTH_TYPE", "secret");
      const cfg = config({
        enabled: true,
        ...identity("default"),
        accounts: { support: identity("support") },
      });
      const next = msteamsConfigAdapter.deleteAccount({
        cfg: storage === "environment-only" ? {} : cfg,
        accountId: "default",
      });
      expect(next.channels?.msteams?.appId).toBeUndefined();
      expect(next.channels?.msteams?.appPassword).toBeUndefined();
      expect(next.channels?.msteams?.accounts?.default).toEqual({ enabled: false });
      expect(account(next).enabled).toBe(false);
      if (storage !== "environment-only") {
        expectAccount(next, "support", true);
      }
    },
  );
});
