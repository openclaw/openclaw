import { ChannelType } from "discord-api-types/v10";
import { withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { resolveDiscordChannelAllowlist } from "./resolve-channels.js";
import { jsonResponse, urlToString } from "./test-http-helpers.js";

type Channel = { id: string; name: string; guild_id: string; type: number };
const channel = (id: string, name = "general", guild_id = "111", type = 0): Channel => ({
  id,
  name,
  guild_id,
  type,
});

function resolve(
  entries: string[],
  options: {
    guilds?: { id: string; name: string }[];
    channels?: Channel[];
    lookup?: (id: string) => Response;
  } = {},
) {
  const guilds = options.guilds ?? [{ id: "111", name: "Test Server" }];
  return resolveDiscordChannelAllowlist({
    token: "test",
    entries,
    fetcher: withFetchPreconnect(async (input) => {
      const url = urlToString(input);
      if (url.endsWith("/users/@me/guilds")) {
        return jsonResponse(guilds);
      }
      if (options.channels && guilds.some(({ id }) => url.endsWith(`/guilds/${id}/channels`))) {
        return jsonResponse(options.channels);
      }
      return (
        (/\/channels\/[^/]+$/.test(url)
          ? options.lookup?.(url.split("/").at(-1) ?? "")
          : undefined) ?? new Response("not found", { status: 404 })
      );
    }),
  });
}

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

  it("matches channel names by their letters in any script", async () => {
    const entries = [
      "111/雑談",
      "111/助手",
      "111/alerts",
      "111/general",
      "111/ops",
      "111/雑談-ops",
      "111/\u26A0\uFE0F",
    ];
    const res = await resolve(entries, {
      channels: [
        channel("c1", "お知らせ"),
        channel("c2", "雑談"),
        channel("c3", "\u26A0\uFE0F-alerts"),
        channel("c4", "общий-general"),
        channel("c5", "чат-ops"),
        channel("c6", "ops"),
        channel("c7", "\u2757\uFE0F"),
      ],
    });
    // ASCII keys match by a name's ASCII letters, as before (the first such channel wins).
    // A key with other letters never matches by its ASCII part; an emoji-only key matches nothing.
    expect(res.map(({ resolved, channelId }) => ({ resolved, channelId }))).toEqual([
      { resolved: true, channelId: "c2" },
      { resolved: false, channelId: undefined },
      { resolved: true, channelId: "c3" },
      { resolved: true, channelId: "c4" },
      { resolved: true, channelId: "c5" },
      { resolved: false, channelId: undefined },
      { resolved: false, channelId: undefined },
    ]);
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
