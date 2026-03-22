import { API_CONSTANTS } from "grammy";
import { describe, expect, it } from "vitest";
import { resolveTelegramAllowedUpdates } from "./allowed-updates.js";

describe("resolveTelegramAllowedUpdates", () => {
  it("includes the default update types plus reaction and channel post support", () => {
    const updates = resolveTelegramAllowedUpdates();

    expect(updates).toEqual(expect.arrayContaining([...API_CONSTANTS.DEFAULT_UPDATE_TYPES]));
    expect(updates).toContain("message_reaction");
    expect(updates).toContain("channel_post");
    expect(new Set(updates).size).toBe(updates.length);
  });
});
