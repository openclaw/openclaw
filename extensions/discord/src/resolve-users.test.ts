import { withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { resolveDiscordUserAllowlist } from "./resolve-users.js";
import { jsonResponse, urlToString } from "./test-http-helpers.js";

describe("resolveDiscordUserAllowlist", () => {
  it("resolves a mention without calling listGuilds", async () => {
    const entry = "<@123456789012345678>";
    const requests: string[] = [];
    const results = await resolveDiscordUserAllowlist({
      token: "test",
      entries: [entry],
      fetcher: withFetchPreconnect(async (input) => {
        const url = urlToString(input);
        requests.push(url);
        return url.endsWith("/users/@me/guilds")
          ? jsonResponse([])
          : new Response("not found", { status: 404 });
      }),
    });
    expect(results).toEqual([{ input: entry, resolved: true, id: "123456789012345678" }]);
    expect(requests).toEqual([]);
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

  it("returns unresolved for empty/blank entries", async () => {
    const results = await resolveDiscordUserAllowlist({
      token: "test",
      entries: ["", "  "],
      fetcher: withFetchPreconnect(async () => new Response("not found", { status: 404 })),
    });
    expect(results).toEqual([
      { input: "", resolved: false },
      { input: "  ", resolved: false },
    ]);
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
