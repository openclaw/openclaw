import { ChannelType } from "discord-api-types/v10";
import { withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { resolveDiscordChannelAllowlist } from "./resolve-channels.js";
import { resolveDiscordUserAllowlist } from "./resolve-users.js";
import { jsonResponse, urlToString } from "./test-http-helpers.js";

type Channel = { id: string; name: string; guild_id: string; type: number };
const channel = (id: string, name = "general", guild_id = "111", type = 0): Channel => ({
  id,
  name,
  guild_id,
  type,
});

function makeFetcher(
  options: {
    guilds?: { id: string; name: string }[];
    channels?: Channel[];
    lookup?: (id: string) => Response;
    members?: (query: string) => unknown;
  } = {},
) {
  const guilds = options.guilds ?? [{ id: "111", name: "Test Server" }];
  return withFetchPreconnect(
    vi.fn(async (input: RequestInfo | URL) => {
      const url = urlToString(input);
      if (url.endsWith("/users/@me/guilds")) {
        return jsonResponse(guilds);
      }
      if (options.channels && guilds.some(({ id }) => url.endsWith(`/guilds/${id}/channels`))) {
        return jsonResponse(options.channels);
      }
      if (
        options.members &&
        guilds.some(({ id }) => url.includes(`/guilds/${id}/members/search`))
      ) {
        return jsonResponse(options.members(new URL(url).searchParams.get("query") ?? ""));
      }
      return (
        (/\/channels\/[^/]+$/.test(url)
          ? options.lookup?.(url.split("/").at(-1) ?? "")
          : undefined) ?? new Response("not found", { status: 404 })
      );
    }),
  );
}
const resolve = (entries: string[], options?: Parameters<typeof makeFetcher>[0]) =>
  resolveDiscordChannelAllowlist({ token: "test", entries, fetcher: makeFetcher(options) });

describe("resolveDiscordUserAllowlist", () => {
  it("resolves mentions without fetching guilds", async () => {
    const fetcher = makeFetcher();
    expect(
      await resolveDiscordUserAllowlist({
        token: "test",
        entries: ["<@123456789012345678>"],
        fetcher,
      }),
    ).toEqual([{ input: "<@123456789012345678>", resolved: true, id: "123456789012345678" }]);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("loads guilds once for multiple username entries", async () => {
    const fetcher = makeFetcher({
      members: (query) => [{ user: { id: `u-${query}`, username: query, bot: false }, nick: null }],
    });
    expect(
      await resolveDiscordUserAllowlist({ token: "test", entries: ["alice", "bob"], fetcher }),
    ).toMatchObject([
      { resolved: true, input: "alice", id: "u-alice", name: "alice" },
      { resolved: true, input: "bob", id: "u-bob", name: "bob" },
    ]);
    expect(
      fetcher.mock.calls.filter(([input]) => urlToString(input).endsWith("/users/@me/guilds")),
    ).toHaveLength(1);
  });
  it.each([
    ["blank entries", "test", ["", "  "]],
    ["blank token", "  ", ["123456789012345678", "alice"]],
  ] as const)("returns ordered unresolved results for %s", async (_name, token, entries) => {
    expect(
      await resolveDiscordUserAllowlist({ token, entries: [...entries], fetcher: makeFetcher() }),
    ).toEqual(entries.map((input) => ({ input, resolved: false })));
  });
});

describe("resolveDiscordChannelAllowlist", () => {
  it("prefers a matching guild channel over a public thread", async () => {
    const res = await resolve(["My Guild/general"], {
      guilds: [{ id: "g1", name: "My Guild" }],
      channels: [
        channel("thread-1", "general", "g1", ChannelType.PublicThread),
        channel("c1", "general", "g1"),
        channel("c2", "random", "g1"),
      ],
    });
    expect(res[0]).toMatchObject({ resolved: true, guildId: "g1", channelId: "c1" });
  });

  it("reports unresolved when channel id belongs to a different guild", async () => {
    const res = await resolve(["111/222"], {
      guilds: [
        { id: "111", name: "Guild One" },
        { id: "333", name: "Guild Two" },
      ],
      lookup: (id) =>
        id === "222"
          ? jsonResponse(channel("222", "general", "333"))
          : new Response("not found", { status: 404 }),
    });
    expect(res[0]).toEqual({
      input: "111/222",
      resolved: false,
      guildId: "111",
      guildName: "Guild One",
      channelId: "222",
      channelName: "general",
      note: "channel belongs to guild Guild Two",
    });
  });

  it("resolves numeric channel id when guild is specified by name", async () => {
    const res = await resolve(["My Guild/444555666"], {
      guilds: [{ id: "111", name: "My Guild" }],
      channels: [channel("444555666")],
    });
    expect(res[0]).toMatchObject({ resolved: true, channelId: "444555666" });
  });

  it.each([
    { status: 404, failedId: "999000111", message: "not found" },
    { status: 403, failedId: "777888999", message: "Missing Access" },
  ])(
    "keeps resolving a batch after a $status channel lookup",
    async ({ status, failedId, message }) => {
      const res = await resolve([`111/${failedId}`, "111/444555666"], {
        channels: [channel("444555666")],
        lookup: (id) =>
          id === failedId
            ? new Response(message, { status })
            : id === "444555666"
              ? jsonResponse(channel("444555666"))
              : new Response("not found", { status: 404 }),
      });
      expect(res).toHaveLength(2);
      expect(res).toMatchObject([
        { resolved: false, channelId: failedId, guildId: "111" },
        { resolved: true, channelId: "444555666" },
      ]);
    },
  );

  it("falls back to name matching when numeric channel name is not a valid ID", async () => {
    const res = await resolve(["111/2024"], { channels: [channel("c1", "2024"), channel("c2")] });
    expect(res[0]).toMatchObject({
      resolved: true,
      guildId: "111",
      channelId: "c1",
      channelName: "2024",
    });
  });

  it("does not fall back to name matching when channel payload is malformed", async () => {
    const res = await resolve(["111/2024"], {
      channels: [channel("c1", "2024")],
      lookup: (id) =>
        id === "2024"
          ? jsonResponse({ id: "2024", name: "unknown", type: 0 })
          : new Response("not found", { status: 404 }),
    });
    expect(res[0]).toMatchObject({ resolved: false, channelId: "2024", guildId: "111" });
  });

  it("resolves guild: prefixed id as guild (not channel)", async () => {
    const res = await resolve(["guild:111222333444555666"], {
      guilds: [{ id: "111222333444555666", name: "Guild One" }],
      lookup: () => {
        throw new Error("guild id was incorrectly routed to /channels/");
      },
    });
    expect(res[0]).toMatchObject({ resolved: true, guildId: "111222333444555666" });
    expect(res[0]?.channelId).toBeUndefined();
  });

  it("bare numeric guild id is misrouted as channel id (regression)", async () => {
    // Provider must prefix guild-only entries; a bare ID follows channel lookup.
    const res = await resolve(["999"], {
      guilds: [{ id: "999", name: "My Server" }],
      lookup: () => new Response(JSON.stringify({ message: "Unknown Channel" }), { status: 404 }),
    });
    expect(res[0]).toMatchObject({ resolved: false, channelId: "999" });
    expect(res[0]?.guildId).toBeUndefined();
  });
});
