import type { DirectoryConfigParams } from "openclaw/plugin-sdk/directory-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DISCORD_DIRECTORY_LOOKUP_TIMEOUT_MS } from "./api.js";
import { resolveDiscordDirectoryUserId } from "./directory-cache.js";
import { clearDiscordDirectoryCacheForTest } from "./directory-cache.test-support.js";
import { listDiscordDirectoryGroupsLive, listDiscordDirectoryPeersLive } from "./directory-live.js";
import { urlToString } from "./test-http-helpers.js";

function makeParams(
  overrides: Partial<DirectoryConfigParams> = {},
  token = "test-token",
): DirectoryConfigParams {
  return {
    cfg: { channels: { discord: { token } } },
    accountId: "default",
    ...overrides,
  };
}

const guilds = [
  { id: "g1", name: "Guild 1" },
  { id: "g2", name: "Guild 2" },
];

function groupRow(id: string, name: string) {
  return { kind: "group", id: `channel:${id}`, name, handle: `#${name}`, raw: { id, name } };
}

type Member = { user: { id: string; username: string; bot: boolean }; nick: string | null };
function peerRow(raw: Member, name: string, rank: number) {
  const { id, username } = raw.user;
  return { kind: "user", id: `user:${id}`, name, handle: `@${username}`, rank, raw };
}

function mockDirectoryResponses(responses: Record<string, unknown>) {
  const routes: Record<string, unknown> = { "/users/@me/guilds": guilds, ...responses };
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const { pathname, searchParams } = new URL(urlToString(input));
    if (pathname.endsWith("/members/search")) {
      expect(searchParams.get("query")).toBe("alice");
      expect(searchParams.get("limit")).toBe(responses.limit ?? "25");
    }
    return Response.json(routes[pathname.replace(/^\/api\/v\d+/u, "")] ?? []);
  });
}

function hangingBodyResponse(signal?: AbortSignal): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("["));
        signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
      },
    }),
  );
}

describe("discord directory live lookups", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubEnv("DISCORD_BOT_TOKEN", "");
    clearDiscordDirectoryCacheForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it.each([
    ["groups without a token", listDiscordDirectoryGroupsLive, "general", ""],
    ["peers without a query", listDiscordDirectoryPeersLive, "  ", "test-token"],
  ] as const)(
    "returns an empty directory for %s without fetching",
    async (_name, lookup, query, token) => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      expect(await lookup(makeParams({ query }, token))).toStrictEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it("aborts hanging group directory response bodies after the lookup timeout", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_input, init) => hangingBodyResponse(init?.signal ?? undefined));

    const rows = listDiscordDirectoryGroupsLive(makeParams({ query: "general" }));
    const rejection = expect(rows).rejects.toThrow(/abort/i);

    await vi.advanceTimersByTimeAsync(DISCORD_DIRECTORY_LOOKUP_TIMEOUT_MS);
    await rejection;
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("filters group channels by query and respects limit", async () => {
    mockDirectoryResponses({
      "/guilds/g1/channels": [
        { id: "c1", name: "general" },
        { id: "c2", name: "random" },
      ],
      "/guilds/g2/channels": [{ id: "c3", name: "announcements" }],
    });

    const rows = await listDiscordDirectoryGroupsLive(makeParams({ query: "an", limit: 2 }));

    expect(rows).toEqual([groupRow("c2", "random"), groupRow("c3", "announcements")]);
  });

  it("returns ranked peer results and caps member search by limit", async () => {
    const alice = { user: { id: "u1", username: "alice", bot: false }, nick: "Ali" };
    const bot = { user: { id: "u2", username: "alice-bot", bot: true }, nick: null };
    mockDirectoryResponses({
      limit: "2",
      "/users/@me/guilds": guilds.slice(0, 1),
      "/guilds/g1/members/search": [
        alice,
        bot,
        { user: { id: "u3", username: "ignored", bot: false }, nick: null },
      ],
    });

    const rows = await listDiscordDirectoryPeersLive(makeParams({ query: "alice", limit: 2 }));

    expect(rows).toEqual([peerRow(alice, "Ali", 1), peerRow(bot, "alice-bot", 0)]);
  });

  it("does not turn one shared-guild user into ambiguous outbound matches", async () => {
    const fetchSpy = mockDirectoryResponses({
      "/guilds/g1/members/search": [
        { user: { id: "101", username: "alice" }, nick: "first-alice" },
      ],
      "/guilds/g2/members/search": [
        { user: { id: "101", username: "alice" }, nick: "second-alice" },
      ],
    });

    const rows = await listDiscordDirectoryPeersLive(makeParams({ query: "alice" }));

    expect(rows.map((entry) => entry.id)).toEqual(["user:101"]);
    expect(rows.filter((entry) => entry.handle === "@alice")).toHaveLength(1);
    expect(
      ["first-alice", "second-alice"].map((handle) =>
        resolveDiscordDirectoryUserId({ accountId: "default", handle }),
      ),
    ).toEqual(["101", "101"]);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});
