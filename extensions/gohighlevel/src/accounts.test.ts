import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { describe, expect, it, vi, afterEach } from "vitest";
import { resolveGoHighLevelAccount, listGoHighLevelAccountIds } from "./accounts.js";

describe("resolveGoHighLevelAccount", () => {
  afterEach(() => {
    delete process.env.GHL_API_KEY;
    delete process.env.GHL_LOCATION_ID;
  });

  it("resolves from inline config", () => {
    const cfg = {
      channels: {
        gohighlevel: {
          enabled: true,
          apiKey: "pit-test-key",
          locationId: "loc123",
        },
      },
    } as unknown as OpenClawConfig;

    const account = resolveGoHighLevelAccount({ cfg });
    expect(account.credentialSource).toBe("inline");
    expect(account.apiKey).toBe("pit-test-key");
    expect(account.locationId).toBe("loc123");
    expect(account.enabled).toBe(true);
  });

  it("resolves from env vars for default account", () => {
    process.env.GHL_API_KEY = "env-key";
    process.env.GHL_LOCATION_ID = "env-loc";

    const cfg = {
      channels: {
        gohighlevel: { enabled: true },
      },
    } as unknown as OpenClawConfig;

    const account = resolveGoHighLevelAccount({ cfg });
    expect(account.credentialSource).toBe("env");
    expect(account.apiKey).toBe("env-key");
    expect(account.locationId).toBe("env-loc");
  });

  it("returns none when no credentials are available", () => {
    const cfg = {
      channels: {
        gohighlevel: { enabled: true },
      },
    } as unknown as OpenClawConfig;

    const account = resolveGoHighLevelAccount({ cfg });
    expect(account.credentialSource).toBe("none");
    expect(account.apiKey).toBeUndefined();
  });

  it("does not use env vars for non-default account", () => {
    process.env.GHL_API_KEY = "env-key";

    const cfg = {
      channels: {
        gohighlevel: {
          enabled: true,
          accounts: {
            secondary: { enabled: true },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const account = resolveGoHighLevelAccount({ cfg, accountId: "secondary" });
    expect(account.credentialSource).toBe("none");
  });
});

describe("listGoHighLevelAccountIds", () => {
  it("returns default when no accounts configured", () => {
    const cfg = {
      channels: { gohighlevel: { enabled: true } },
    } as unknown as OpenClawConfig;
    expect(listGoHighLevelAccountIds(cfg)).toEqual(["default"]);
  });

  it("returns configured account ids sorted", () => {
    const cfg = {
      channels: {
        gohighlevel: {
          accounts: { beta: {}, alpha: {} },
        },
      },
    } as unknown as OpenClawConfig;
    expect(listGoHighLevelAccountIds(cfg)).toEqual(["alpha", "beta"]);
  });
});
