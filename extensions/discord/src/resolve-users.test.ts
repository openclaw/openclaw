import { withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { resolveDiscordUserAllowlist } from "./resolve-users.js";
import { jsonResponse, urlToString } from "./test-http-helpers.js";

type DiscordAllowlistResult = Awaited<ReturnType<typeof resolveDiscordUserAllowlist>>[number];

function expectResolvedUser(
  result: DiscordAllowlistResult | undefined,
  expected: { id: string; input?: string; name?: string },
) {
  if (!result) {
    throw new Error("expected Discord allowlist result");
  }
  expect(result.resolved).toBe(true);
  expect(result.id).toBe(expected.id);
  if (expected.input !== undefined) {
    expect(result.input).toBe(expected.input);
  }
  if (expected.name !== undefined) {
    expect(result.name).toBe(expected.name);
  }
}

function expectUnresolvedUser(result: DiscordAllowlistResult | undefined) {
  if (!result) {
    throw new Error("expected Discord allowlist result");
  }
  expect(result.resolved).toBe(false);
}

function createGuildListProbeFetcher() {
  let guildsCalled = false;
  const fetcher = withFetchPreconnect(async (input: RequestInfo | URL) => {
    const url = urlToString(input);
    if (url.endsWith("/users/@me/guilds")) {
      guildsCalled = true;
      return jsonResponse([]);
    }
    return new Response("not found", { status: 404 });
  });
  return {
    fetcher,
    wasGuildsCalled: () => guildsCalled,
  };
}

describe("resolveDiscordUserAllowlist", () => {
  it.each(["<@123456789012345678>"])("resolves %s without calling listGuilds", async (entry) => {
    const { fetcher, wasGuildsCalled } = createGuildListProbeFetcher();

    const results = await resolveDiscordUserAllowlist({
      token: "test",
      entries: [entry],
      fetcher,
    });

    expect(results).toEqual([
      {
        input: entry,
        resolved: true,
        id: "123456789012345678",
      },
    ]);
    expect(wasGuildsCalled()).toBe(false);
  });

  it("fetches guilds only once for multiple username entries", async () => {
    let guildsCallCount = 0;
    const fetcher = withFetchPreconnect(async (input: RequestInfo | URL) => {
      const url = urlToString(input);
      if (url.endsWith("/users/@me/guilds")) {
        guildsCallCount++;
        return jsonResponse([{ id: "g1", name: "Test Guild" }]);
      }
      if (url.includes("/guilds/g1/members/search")) {
        const params = new URL(url).searchParams;
        const query = params.get("query") ?? "";
        return jsonResponse([
          {
            user: { id: `u-${query}`, username: query, bot: false },
            nick: null,
          },
        ]);
      }
      return new Response("not found", { status: 404 });
    });

    const results = await resolveDiscordUserAllowlist({
      token: "test",
      entries: ["alice", "bob"],
      fetcher,
    });

    expect(guildsCallCount).toBe(1);
    expect(results).toHaveLength(2);
    expectResolvedUser(results[0], { input: "alice", id: "u-alice", name: "alice" });
    expectResolvedUser(results[1], { input: "bob", id: "u-bob", name: "bob" });
  });

  it("returns unresolved for empty/blank entries", async () => {
    const fetcher = withFetchPreconnect(async () => {
      return new Response("not found", { status: 404 });
    });

    const results = await resolveDiscordUserAllowlist({
      token: "test",
      entries: ["", "  "],
      fetcher,
    });

    expect(results).toHaveLength(2);
    expectUnresolvedUser(results[0]);
    expectUnresolvedUser(results[1]);
  });

  it("returns ordered unresolved entries when token is blank", async () => {
    const results = await resolveDiscordUserAllowlist({
      token: "  ",
      entries: ["123456789012345678", "alice"],
    });

    expect(results).toEqual([
      { input: "123456789012345678", resolved: false },
      { input: "alice", resolved: false },
    ]);
  });
});
