import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listZalouserAccountIds,
  resolveDefaultZalouserAccountId,
  resolveZalouserAccountSync,
} from "./accounts.js";
function config(zalouser: NonNullable<OpenClawConfig["channels"]>["zalouser"]): OpenClawConfig {
  return { channels: { zalouser } };
}

describe("zalouser account resolution", () => {
  beforeEach(() => {
    vi.stubEnv("ZALOUSER_PROFILE", undefined);
    vi.stubEnv("ZCA_PROFILE", undefined);
  });

  afterEach(() => vi.unstubAllEnvs());

  it("preserves top-level default account when named accounts are configured", () => {
    const cfg = config({
      profile: "personal",
      accounts: { work: { enabled: false } },
    });

    expect(listZalouserAccountIds(cfg)).toEqual(["default", "work"]);
    expect(resolveDefaultZalouserAccountId(cfg)).toBe("default");
    expect(resolveZalouserAccountSync({ cfg }).profile).toBe("personal");
  });

  it("resolves sync account by merging base + account config", () => {
    const cfg = config({
      enabled: true,
      dmPolicy: "pairing",
      accounts: {
        work: {
          enabled: false,
          name: "Work",
          dmPolicy: "allowlist",
          allowFrom: ["123"],
        },
      },
    });

    const resolved = resolveZalouserAccountSync({ cfg, accountId: "work" });
    expect(resolved).toMatchObject({
      accountId: "work",
      enabled: false,
      name: "Work",
      config: { dmPolicy: "allowlist", allowFrom: ["123"] },
    });
  });

  it("uses configured defaultAccount when accountId is omitted", () => {
    const cfg = config({
      defaultAccount: "work",
      accounts: { work: { name: "Work", profile: "work-profile" } },
    });

    const resolved = resolveZalouserAccountSync({ cfg });
    expect(resolved).toMatchObject({ accountId: "work", name: "Work", profile: "work-profile" });
  });

  it("resolves profile precedence correctly", () => {
    const cfg = config({ accounts: { work: {} } });

    vi.stubEnv("ZALOUSER_PROFILE", "zalo-env");
    expect(resolveZalouserAccountSync({ cfg, accountId: "work" }).profile).toBe("zalo-env");

    vi.stubEnv("ZALOUSER_PROFILE", undefined);
    vi.stubEnv("ZCA_PROFILE", "zca-env");
    expect(resolveZalouserAccountSync({ cfg, accountId: "work" }).profile).toBe("zca-env");

    vi.stubEnv("ZCA_PROFILE", undefined);
    expect(resolveZalouserAccountSync({ cfg, accountId: "work" }).profile).toBe("work");
  });

  it("uses explicit profile from config over env fallback", () => {
    vi.stubEnv("ZALOUSER_PROFILE", "env-profile");
    const cfg = config({ accounts: { work: { profile: "explicit-profile" } } });

    expect(resolveZalouserAccountSync({ cfg, accountId: "work" }).profile).toBe("explicit-profile");
  });
});
