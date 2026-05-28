import { afterEach, describe, expect, it } from "vitest";
import {
  checkRateLimit,
  isAllowedUser,
  isOwnerUser,
  loadPermissionConfigFromEnv,
} from "./permission-manager.js";

const ENV_KEYS = [
  "OPENCLAW_TELEGRAM_OWNER_IDS",
  "OPENCLAW_TELEGRAM_ALLOWED_IDS",
  "OPENCLAW_TELEGRAM_RATE_LIMIT_PER_MINUTE",
  "OPENCLAW_TELEGRAM_RATE_LIMIT_TOKENS_PER_DAY",
] as const;

const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("permission-manager", () => {
  it("loads owner and allow list from env", () => {
    process.env.OPENCLAW_TELEGRAM_OWNER_IDS = "1001,1002";
    process.env.OPENCLAW_TELEGRAM_ALLOWED_IDS = "2001 2002";
    const cfg = loadPermissionConfigFromEnv();
    expect(cfg.ownerTelegramIds).toEqual([1001, 1002]);
    expect(cfg.allowedTelegramIds).toEqual([2001, 2002]);
  });

  it("allows owner even when allow list is set", () => {
    process.env.OPENCLAW_TELEGRAM_OWNER_IDS = "9";
    process.env.OPENCLAW_TELEGRAM_ALLOWED_IDS = "10";
    const cfg = loadPermissionConfigFromEnv();
    expect(isOwnerUser(9, cfg)).toBe(true);
    expect(isAllowedUser(9, cfg)).toBe(true);
    expect(isAllowedUser(10, cfg)).toBe(true);
    expect(isAllowedUser(11, cfg)).toBe(false);
  });

  it("applies rate limit from env", () => {
    process.env.OPENCLAW_TELEGRAM_RATE_LIMIT_PER_MINUTE = "1";
    const cfg = loadPermissionConfigFromEnv();
    const userId = 999;
    expect(checkRateLimit(userId, cfg)).toBe(true);
    expect(checkRateLimit(userId, cfg)).toBe(false);
  });
});
