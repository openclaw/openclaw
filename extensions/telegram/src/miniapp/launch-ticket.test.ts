import { afterEach, describe, expect, it, vi } from "vitest";
import {
  consumeTelegramMiniAppLaunchTicket,
  issueTelegramMiniAppLaunchTicket,
} from "./launch-ticket.js";

describe("Telegram Mini App launch tickets", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("binds a single use to the issuing account and owner", () => {
    const ticket = issueTelegramMiniAppLaunchTicket({
      accountId: "ops",
      userId: "123",
    });

    expect(
      consumeTelegramMiniAppLaunchTicket({
        ticket,
        accountId: "default",
        userId: "123",
      }),
    ).toBe(false);
    expect(
      consumeTelegramMiniAppLaunchTicket({
        ticket,
        accountId: "ops",
        userId: "999",
      }),
    ).toBe(false);
    expect(
      consumeTelegramMiniAppLaunchTicket({
        ticket,
        accountId: "ops",
        userId: "123",
      }),
    ).toBe(true);
    expect(
      consumeTelegramMiniAppLaunchTicket({
        ticket,
        accountId: "ops",
        userId: "123",
      }),
    ).toBe(false);
  });

  it("expires after five minutes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T12:00:00Z"));
    const ticket = issueTelegramMiniAppLaunchTicket({
      accountId: "default",
      userId: "123",
    });

    vi.advanceTimersByTime(5 * 60_000);

    expect(
      consumeTelegramMiniAppLaunchTicket({
        ticket,
        accountId: "default",
        userId: "123",
      }),
    ).toBe(false);
  });
});
