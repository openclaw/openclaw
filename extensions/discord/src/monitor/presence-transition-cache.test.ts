import { describe, expect, it } from "vitest";
import { DiscordOfflinePresenceCache } from "./presence-transition-cache.js";

describe("DiscordOfflinePresenceCache", () => {
  it("retains only bounded recent offline markers", () => {
    const cache = new DiscordOfflinePresenceCache({ ttlMs: 100, maxEntries: 2 });

    cache.observeOffline("oldest", 0);
    cache.observeOffline("middle", 1);
    cache.observeOffline("newest", 2);

    expect(cache.hasRecentOffline("oldest", 2)).toBe(false);
    expect(cache.hasRecentOffline("middle", 2)).toBe(true);
    expect(cache.hasRecentOffline("newest", 102)).toBe(false);
  });

  it("clears every marker for a new gateway session", () => {
    const cache = new DiscordOfflinePresenceCache({ ttlMs: 100, maxEntries: 2 });
    cache.observeOffline("member", 0);

    cache.clear();

    expect(cache.hasRecentOffline("member", 1)).toBe(false);
  });
});
