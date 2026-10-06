// Discord tests cover entity cache plugin behavior.
import { GatewayDispatchEvents } from "discord-api-types/v10";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscordEntityCache } from "./entity-cache.js";
import type { RequestClient } from "./rest.js";
import type { StructureClient } from "./structures.js";

function makeCache() {
  let getCalls = 0;
  const rest = {
    get: async (route: string) => {
      getCalls += 1;
      const id = route.split("/").pop() ?? "x";
      return { id };
    },
  } as unknown as RequestClient;
  const client = {} as StructureClient;
  const cache = new DiscordEntityCache({ client, rest: () => rest });
  return { cache, getCalls: () => getCalls };
}

describe("DiscordEntityCache eviction", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("caps entries by dropping oldest on insert past 5,000 entries", async () => {
    vi.useFakeTimers();
    const { cache, getCalls } = makeCache();
    for (let index = 0; index < 5_000; index += 1) {
      await cache.fetchUser(`u${index}`);
    }
    expect(cache.size).toBe(5_000);
    await cache.fetchUser("new-user");
    expect(cache.size).toBe(5_000);
    await cache.fetchUser("u0");
    expect(getCalls()).toBe(5_002);
  });

  it("sweeps expired entries on insert when sweep interval has elapsed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { cache } = makeCache();

    await cache.fetchUser("u1");
    await cache.fetchUser("u2");
    expect(cache.size).toBe(2);

    vi.advanceTimersByTime(30_000);

    await cache.fetchUser("u3");
    expect(cache.size).toBe(1);
  });

  it("reuses normalized guild emojis until their cache entry expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { cache } = makeCache();
    const fetchEmojis = vi.fn(async () => [{ name: "party", identifier: "party:1" }]);

    expect(await cache.fetchGuildEmojis("g1", fetchEmojis)).toEqual([
      { name: "party", identifier: "party:1" },
    ]);
    await cache.fetchGuildEmojis("g1", fetchEmojis);
    expect(fetchEmojis).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(30_000);
    await cache.fetchGuildEmojis("g1", fetchEmojis);
    expect(fetchEmojis).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["updated", GatewayDispatchEvents.ThreadUpdate],
    ["deleted", GatewayDispatchEvents.ThreadDelete],
  ])("invalidates cached channels when a thread is %s", async (_label, eventType) => {
    const { cache, getCalls } = makeCache();

    await cache.fetchChannel("thread-42");
    await cache.fetchChannel("thread-42");
    expect(getCalls()).toBe(1);

    cache.invalidateForGatewayEvent(eventType, { id: "thread-42" });
    await cache.fetchChannel("thread-42");

    expect(getCalls()).toBe(2);
  });
});

describe("DiscordEntityCache gateway invalidation", () => {
  it("invalidates only the updated guild's normalized emoji list", async () => {
    const { cache } = makeCache();
    const fetchEmojis = vi.fn(async () => [{ name: "party", identifier: "party:1" }]);

    await cache.fetchGuildEmojis("g1", fetchEmojis);
    await cache.fetchGuildEmojis("g2", fetchEmojis);
    cache.invalidateForGatewayEvent(GatewayDispatchEvents.GuildEmojisUpdate, { guild_id: "g1" });
    await cache.fetchGuildEmojis("g1", fetchEmojis);
    await cache.fetchGuildEmojis("g2", fetchEmojis);

    expect(fetchEmojis).toHaveBeenCalledTimes(3);
  });

  it.each([
    GatewayDispatchEvents.GuildMemberAdd,
    GatewayDispatchEvents.GuildMemberRemove,
    GatewayDispatchEvents.GuildMemberUpdate,
  ])("invalidates member and user entries for %s", async (event) => {
    const { cache, getCalls } = makeCache();

    await cache.fetchMember("g1", "u1");
    await cache.fetchUser("u1");
    await cache.fetchMember("g1", "u1");
    await cache.fetchUser("u1");
    expect(getCalls()).toBe(2);

    cache.invalidateForGatewayEvent(event, { guild_id: "g1", user: { id: "u1" } });

    await cache.fetchMember("g1", "u1");
    await cache.fetchUser("u1");
    expect(getCalls()).toBe(4);
  });
});
