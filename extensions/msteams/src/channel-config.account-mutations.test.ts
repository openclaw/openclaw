import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveMSTeamsAccount } from "./accounts.js";
import { msteamsConfigAdapter } from "./channel-config.js";

describe("msteams account config mutations", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("disables the root default without disabling siblings", () => {
    const identity = { appId: "default-app", appPassword: "default-secret" };
    const cfg: OpenClawConfig = {
      channels: {
        msteams: {
          tenantId: "tenant-id",
          ...identity,
          accounts: {
            support: { appId: "support-app", appPassword: "support-secret" },
          },
        },
      },
    };
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
    const cfg = {
      channels: {
        msteams: {
          tenantId: "tenant-id",
          defaultAccount: "support",
          accounts: {
            support: { appId: "support-app", appPassword: "support-secret" },
            zeta: { appId: "zeta-app", appPassword: "zeta-secret" },
            alpha: { appId: "alpha-app", appPassword: "alpha-secret" },
          },
        },
      },
    } satisfies OpenClawConfig;

    const updated = msteamsConfigAdapter.deleteAccount({ cfg, accountId: "support" });

    expect(updated.channels?.msteams?.defaultAccount).toBeUndefined();
    expect(resolveMSTeamsAccount({ cfg: updated }).accountId).toBe("alpha");
  });

  it("falls back to a legacy root identity after deleting the last named default", () => {
    const cfg = {
      channels: {
        msteams: {
          appId: "legacy-app",
          appPassword: "legacy-secret",
          tenantId: "tenant-id",
          defaultAccount: "support",
          accounts: {
            support: { appId: "explicit-app", appPassword: "explicit-secret" },
          },
        },
      },
    } satisfies OpenClawConfig;

    const updated = msteamsConfigAdapter.deleteAccount({ cfg, accountId: "support" });

    expect(updated.channels?.msteams?.accounts).toBeUndefined();
    expect(updated.channels?.msteams?.defaultAccount).toBeUndefined();
    expect(resolveMSTeamsAccount({ cfg: updated })).toMatchObject({
      accountId: "default",
      configured: true,
    });
  });
  it("re-enables a sole legacy default through the channel gate", () => {
    const cfg: OpenClawConfig = {
      channels: {
        msteams: {
          enabled: false,
          appId: "legacy-app",
          appPassword: "legacy-secret",
          tenantId: "tenant-id",
        },
      },
    };
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
      const identity = { appId: "default-app", appPassword: "default-secret" };
      const cfg: OpenClawConfig = {
        channels: {
          msteams: {
            enabled: true,
            tenantId: "tenant-id",
            ...identity,
            accounts: {
              support: { appId: "support-app", appPassword: "support-secret" },
            },
          },
        },
      };
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
