import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatTelegramAuthBadge,
  resolveTelegramAuthBadge,
  resolveTelegramProSource,
  resolveTelegramProStatus,
} from "./pro-status.js";

describe("telegram-ui pro status", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns false by default", () => {
    expect(resolveTelegramProStatus(42)).toBe(false);
  });

  it("returns true when OPENCLAW_TELEGRAM_PRO_ALL is enabled", () => {
    vi.stubEnv("OPENCLAW_TELEGRAM_PRO_ALL", "true");
    expect(resolveTelegramProStatus(42)).toBe(true);
  });

  it("treats uppercase YES as enabled OPENCLAW_TELEGRAM_PRO_ALL", () => {
    vi.stubEnv("OPENCLAW_TELEGRAM_PRO_ALL", "YES");
    expect(resolveTelegramProSource(77)).toBe("PRO_ALL");
    expect(resolveTelegramProStatus(77)).toBe(true);
  });

  it("treats mixed-case true as enabled OPENCLAW_TELEGRAM_PRO_ALL", () => {
    vi.stubEnv("OPENCLAW_TELEGRAM_PRO_ALL", "TrUe");
    expect(resolveTelegramProSource(77)).toBe("PRO_ALL");
    expect(resolveTelegramProStatus(77)).toBe(true);
  });

  it("treats spaced numeric alias as enabled OPENCLAW_TELEGRAM_PRO_ALL", () => {
    vi.stubEnv("OPENCLAW_TELEGRAM_PRO_ALL", " 1 ");
    expect(resolveTelegramProSource(77)).toBe("PRO_ALL");
    expect(resolveTelegramProStatus(77)).toBe(true);
  });

  it("treats newline and tab wrapped true alias as enabled OPENCLAW_TELEGRAM_PRO_ALL", () => {
    vi.stubEnv("OPENCLAW_TELEGRAM_PRO_ALL", "\ntrue\t");
    expect(resolveTelegramProSource(77)).toBe("PRO_ALL");
    expect(resolveTelegramProStatus(77)).toBe(true);
  });

  it("treats spaced no alias as disabled OPENCLAW_TELEGRAM_PRO_ALL", () => {
    vi.stubEnv("OPENCLAW_TELEGRAM_PRO_ALL", " no ");
    vi.stubEnv("OPENCLAW_TELEGRAM_PRO_USERS", "");
    expect(resolveTelegramProSource(77)).toBe("none");
    expect(resolveTelegramProStatus(77)).toBe(false);
  });

  it("treats spaced false alias as disabled OPENCLAW_TELEGRAM_PRO_ALL", () => {
    vi.stubEnv("OPENCLAW_TELEGRAM_PRO_ALL", " false ");
    vi.stubEnv("OPENCLAW_TELEGRAM_PRO_USERS", "");
    expect(resolveTelegramProSource(77)).toBe("none");
    expect(resolveTelegramProStatus(77)).toBe(false);
  });

  it("treats uppercase spaced false alias as disabled OPENCLAW_TELEGRAM_PRO_ALL", () => {
    vi.stubEnv("OPENCLAW_TELEGRAM_PRO_ALL", "  FALSE  ");
    vi.stubEnv("OPENCLAW_TELEGRAM_PRO_USERS", "");
    expect(resolveTelegramProSource(77)).toBe("none");
    expect(resolveTelegramProStatus(77)).toBe(false);
  });

  it("treats tab/newline wrapped zero alias as disabled OPENCLAW_TELEGRAM_PRO_ALL", () => {
    vi.stubEnv("OPENCLAW_TELEGRAM_PRO_ALL", "\t0\n");
    vi.stubEnv("OPENCLAW_TELEGRAM_PRO_USERS", "");
    expect(resolveTelegramProSource(77)).toBe("none");
    expect(resolveTelegramProStatus(77)).toBe(false);
  });

  it("supports wildcard OPENCLAW_TELEGRAM_PRO_USERS", () => {
    vi.stubEnv("OPENCLAW_TELEGRAM_PRO_USERS", "*");
    expect(resolveTelegramProStatus(42)).toBe(true);
  });

  it("supports mixed separators in OPENCLAW_TELEGRAM_PRO_USERS", () => {
    vi.stubEnv("OPENCLAW_TELEGRAM_PRO_USERS", "11,22 33;44|55");
    expect(resolveTelegramProStatus(44)).toBe(true);
    expect(resolveTelegramProStatus(99)).toBe(false);
  });

  it("returns false for invalid user id when pro_all is disabled", () => {
    vi.stubEnv("OPENCLAW_TELEGRAM_PRO_USERS", "42");
    expect(resolveTelegramProStatus(0)).toBe(false);
    expect(resolveTelegramProStatus(Number.NaN)).toBe(false);
  });

  it("formats auth badge with a stable label", () => {
    expect(formatTelegramAuthBadge(true)).toBe("⭐ Pro");
    expect(formatTelegramAuthBadge(false)).toBe("🆓 Free");
  });

  it("resolves auth badge by user id and env policy", () => {
    vi.stubEnv("OPENCLAW_TELEGRAM_PRO_USERS", "42");
    expect(resolveTelegramAuthBadge(42)).toBe("⭐ Pro");
    expect(resolveTelegramAuthBadge(99)).toBe("🆓 Free");
  });

  it("resolves pro source code for user id", () => {
    vi.stubEnv("OPENCLAW_TELEGRAM_PRO_USERS", "42");
    expect(resolveTelegramProSource(42)).toBe("PRO_USERS");
    expect(resolveTelegramProSource(7)).toBe("none");
  });

  it("accepts only positive numeric user ids from mixed OPENCLAW_TELEGRAM_PRO_USERS values", () => {
    vi.stubEnv("OPENCLAW_TELEGRAM_PRO_USERS", "abc,-1,0, 42 ; foo | 77");
    expect(resolveTelegramProSource(42)).toBe("PRO_USERS");
    expect(resolveTelegramProSource(77)).toBe("PRO_USERS");
    expect(resolveTelegramProSource(99)).toBe("none");
  });

  it("returns none when OPENCLAW_TELEGRAM_PRO_USERS has no valid positive ids", () => {
    vi.stubEnv("OPENCLAW_TELEGRAM_PRO_USERS", "abc,-1,0,NaN");
    expect(resolveTelegramProSource(42)).toBe("none");
  });

  it("treats mixed wildcard token list as explicit ids instead of full wildcard", () => {
    vi.stubEnv("OPENCLAW_TELEGRAM_PRO_USERS", "* ,42");
    expect(resolveTelegramProSource(42)).toBe("PRO_USERS");
    expect(resolveTelegramProSource(77)).toBe("none");
    expect(resolveTelegramProStatus(42)).toBe(true);
    expect(resolveTelegramProStatus(77)).toBe(false);
  });

  it("prioritizes PRO_ALL over mixed wildcard token list", () => {
    vi.stubEnv("OPENCLAW_TELEGRAM_PRO_ALL", "true");
    vi.stubEnv("OPENCLAW_TELEGRAM_PRO_USERS", "* ,42");
    expect(resolveTelegramProSource(77)).toBe("PRO_ALL");
    expect(resolveTelegramProStatus(77)).toBe(true);
  });
});
