import { API_CONSTANTS } from "grammy";
import { beforeEach, describe, expect, it, vi } from "vitest";

type AllowedUpdatesModule = typeof import("./allowed-updates.js");

let DEFAULT_TELEGRAM_UPDATE_TYPES: AllowedUpdatesModule["DEFAULT_TELEGRAM_UPDATE_TYPES"];
let resolveTelegramAllowedUpdates: AllowedUpdatesModule["resolveTelegramAllowedUpdates"];

describe("resolveTelegramAllowedUpdates", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ DEFAULT_TELEGRAM_UPDATE_TYPES, resolveTelegramAllowedUpdates } =
      await import("./allowed-updates.js"));
  });

  it("includes the default update types plus reaction and channel post support", () => {
    const updates = resolveTelegramAllowedUpdates();

    expect(updates).toEqual(
      expect.arrayContaining([
        ...DEFAULT_TELEGRAM_UPDATE_TYPES,
        ...(API_CONSTANTS?.DEFAULT_UPDATE_TYPES ?? []),
      ]),
    );
    expect(updates).toContain("message_reaction");
    expect(updates).toContain("channel_post");
    expect(new Set(updates).size).toBe(updates.length);
  });
});
