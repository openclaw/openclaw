import { GatewayDispatchEvents } from "discord-api-types/v10";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DiscordEntityCache } from "./entity-cache.js";
import { attachRestMock, createInternalTestClient } from "./test-builders.test-support.js";

let cache: DiscordEntityCache;
const get = vi.fn(async (route: string) => ({ id: route.split("/").pop() ?? "x" }));
const emojis = [{ name: "party", identifier: "party:1" }];
const fetchEmojis = vi.fn(async () => emojis);
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  const client = createInternalTestClient();
  attachRestMock(client, { get });
  cache = new DiscordEntityCache(client);
});
afterEach(() => vi.useRealTimers());

it("caps entries by dropping oldest on insert past 5,000 entries", async () => {
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
  await cache.fetchUser("u1");
  await cache.fetchUser("u2");
  expect(cache.size).toBe(2);
  vi.advanceTimersByTime(30_000);
  await cache.fetchUser("u3");
  expect(cache.size).toBe(1);
});

it("reuses normalized guild emojis until their cache entry expires", async () => {
  expect(await cache.fetchGuildEmojis("g1", fetchEmojis)).toEqual([
    { name: "party", identifier: "party:1" },
  ]);
  await cache.fetchGuildEmojis("g1", fetchEmojis);
  expect(fetchEmojis).toHaveBeenCalledTimes(1);

  vi.advanceTimersByTime(30_000);
  await cache.fetchGuildEmojis("g1", fetchEmojis);
  expect(fetchEmojis).toHaveBeenCalledTimes(2);
});

it("invalidates only the updated guild's normalized emoji list", async () => {
  await cache.fetchGuildEmojis("g1", fetchEmojis);
  await cache.fetchGuildEmojis("g2", fetchEmojis);
  cache.invalidateForGatewayEvent(GatewayDispatchEvents.GuildEmojisUpdate, { guild_id: "g1" });
  await cache.fetchGuildEmojis("g1", fetchEmojis);
  await cache.fetchGuildEmojis("g2", fetchEmojis);

  expect(fetchEmojis).toHaveBeenCalledTimes(3);
});

it("invalidates member and user entries for GuildMemberUpdate", async () => {
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
