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

describe("msteams account config mutations", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("disables the root default without disabling siblings", () => {
    const cfg = config({ ...identity("default"), accounts: { support: identity("support") } });
    const updated = msteamsConfigAdapter.setAccountEnabled({
      cfg,
      accountId: "default",
      enabled: false,
    });
    expect(updated.channels?.msteams?.enabled).toBeUndefined();
    expect(resolveMSTeamsAccount({ cfg: updated, accountId: "default" })).toMatchObject({
      enabled: false,
      configured: true,
    });
    expect(resolveMSTeamsAccount({ cfg: updated, accountId: "support" })).toMatchObject({
      enabled: true,
      configured: true,
    });
  });

  it("selects the sorted eligible account after deleting the configured default", () => {
    const cfg = config({
      defaultAccount: "support",
      accounts: { support: identity("support"), zeta: identity("zeta"), alpha: identity("alpha") },
    });

    const updated = msteamsConfigAdapter.deleteAccount({ cfg, accountId: "support" });

    expect(updated.channels?.msteams?.defaultAccount).toBeUndefined();
    expect(resolveMSTeamsAccount({ cfg: updated }).accountId).toBe("alpha");
  });

  it("falls back to a legacy root identity after deleting the last named default", () => {
    const cfg = config({
      ...identity("legacy"),
      defaultAccount: "support",
      accounts: { support: identity("explicit") },
    });

    const updated = msteamsConfigAdapter.deleteAccount({ cfg, accountId: "support" });

    expect(updated.channels?.msteams?.accounts).toBeUndefined();
    expect(updated.channels?.msteams?.defaultAccount).toBeUndefined();
    expect(resolveMSTeamsAccount({ cfg: updated })).toMatchObject({
      accountId: "default",
      configured: true,
    });
  });
  it("re-enables a sole legacy default through the channel gate", () => {
    const cfg = config({ enabled: false, ...identity("legacy") });
    const next = msteamsConfigAdapter.setAccountEnabled({
      cfg,
      accountId: "default",
      enabled: true,
    });
    expect(next.channels?.msteams?.enabled).toBe(true);
    expect(resolveMSTeamsAccount({ cfg: next, accountId: "default" })).toMatchObject({
      enabled: true,
      configured: true,
      config: { appId: "legacy-app" },
    });
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
      expect(next.channels?.msteams?.accounts?.default).toEqual({ enabled: false });
      expect(next.channels?.msteams?.appId).toBeUndefined();
      expect(next.channels?.msteams?.appPassword).toBeUndefined();
      expect(resolveMSTeamsAccount({ cfg: next, accountId: "default" })).toMatchObject({
        enabled: false,
      });
      if (storage !== "environment-only") {
        expect(resolveMSTeamsAccount({ cfg: next, accountId: "support" })).toMatchObject({
          enabled: true,
          configured: true,
        });
      }
    },
  );
});
