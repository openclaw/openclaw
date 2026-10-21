import { withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { resolveDiscordUserAllowlist } from "./resolve-users.js";
import { jsonResponse, urlToString } from "./test-http-helpers.js";

describe("resolveDiscordUserAllowlist", () => {
  it("resolves a mention without calling listGuilds", async () => {
    const entry = "<@123456789012345678>";
    const fetcher = withFetchPreconnect(vi.fn(async () => new Response(null, { status: 404 })));
    const results = await resolveDiscordUserAllowlist({
      token: "test",
      entries: [entry],
      fetcher,
    });
    expect(results).toEqual([{ input: entry, resolved: true, id: "123456789012345678" }]);
    expect(fetcher).not.toHaveBeenCalled();
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
        const query = new URL(url).searchParams.get("query") ?? "";
        return jsonResponse([
          { user: { id: `u-${query}`, username: query, bot: false }, nick: null },
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
    expect(results).toMatchObject([
      { resolved: true, input: "alice", id: "u-alice", name: "alice" },
      { resolved: true, input: "bob", id: "u-bob", name: "bob" },
    ]);
  });

  it.each([
    ["blank entries", "test", ["", "  "]],
    ["blank token", "  ", ["123456789012345678", "alice"]],
  ] as const)("returns ordered unresolved results for %s", async (_name, token, entries) => {
    expect(
      await resolveDiscordUserAllowlist({
        token,
        entries: [...entries],
        fetcher: withFetchPreconnect(async () => new Response("not found", { status: 404 })),
      }),
    ).toEqual(entries.map((input) => ({ input, resolved: false })));
  });
});
