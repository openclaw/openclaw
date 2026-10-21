import { GatewayDispatchEvents } from "discord-api-types/v10";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiscordEntityCache } from "./entity-cache.js";
import { attachRestMock, createInternalTestClient } from "./test-builders.test-support.js";

function makeCache() {
  const client = createInternalTestClient();
  const get = vi.fn(async (route: string) => ({ id: route.split("/").pop() ?? "x" }));
  attachRestMock(client, { get });
  return { cache: new DiscordEntityCache(client), get };
}

const emojis = [{ name: "party", identifier: "party:1" }];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("DiscordEntityCache eviction", () => {
  it("caps entries by dropping oldest on insert past 5,000 entries", async () => {
    const { cache, get } = makeCache();
    for (let index = 0; index < 5_000; index += 1) {
      await cache.fetchUser(`u${index}`);
    }
    expect(cache.size).toBe(5_000);
    await cache.fetchUser("new-user");
    expect(cache.size).toBe(5_000);
    await cache.fetchUser("u0");
    expect(get).toHaveBeenCalledTimes(5_002);
  });

  it("sweeps expired entries on insert when sweep interval has elapsed", async () => {
    const { cache } = makeCache();
    await cache.fetchUser("u1");
    await cache.fetchUser("u2");
    expect(cache.size).toBe(2);

    vi.advanceTimersByTime(30_000);

    await cache.fetchUser("u3");
    expect(cache.size).toBe(1);
  });

  it("reuses normalized guild emojis until their cache entry expires", async () => {
    const { cache } = makeCache();
    const fetchEmojis = vi.fn(async () => emojis);
    expect(await cache.fetchGuildEmojis("g1", fetchEmojis)).toEqual([
      { name: "party", identifier: "party:1" },
    ]);
    await cache.fetchGuildEmojis("g1", fetchEmojis);
    expect(fetchEmojis).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(30_000);
    await cache.fetchGuildEmojis("g1", fetchEmojis);
    expect(fetchEmojis).toHaveBeenCalledTimes(2);
  });
});

describe("DiscordEntityCache gateway invalidation", () => {
  it("invalidates only the updated guild's normalized emoji list", async () => {
    const { cache } = makeCache();
    const fetchEmojis = vi.fn(async () => emojis);

    await cache.fetchGuildEmojis("g1", fetchEmojis);
    await cache.fetchGuildEmojis("g2", fetchEmojis);
    cache.invalidateForGatewayEvent(GatewayDispatchEvents.GuildEmojisUpdate, { guild_id: "g1" });
    await cache.fetchGuildEmojis("g1", fetchEmojis);
    await cache.fetchGuildEmojis("g2", fetchEmojis);

    expect(fetchEmojis).toHaveBeenCalledTimes(3);
  });

  it("invalidates member and user entries for GuildMemberUpdate", async () => {
    const { cache, get } = makeCache();

    await cache.fetchMember("g1", "u1");
    await cache.fetchUser("u1");
    await cache.fetchMember("g1", "u1");
    await cache.fetchUser("u1");
    expect(get).toHaveBeenCalledTimes(2);

    cache.invalidateForGatewayEvent(GatewayDispatchEvents.GuildMemberUpdate, {
      guild_id: "g1",
      user: { id: "u1" },
    });

    await cache.fetchMember("g1", "u1");
    await cache.fetchUser("u1");
    expect(get).toHaveBeenCalledTimes(4);
  });
});
