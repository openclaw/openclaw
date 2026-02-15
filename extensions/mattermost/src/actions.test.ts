import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mattermostMessageActions } from "./actions.js";
import {
  createMattermostClient,
  fetchChannelPosts,
  fetchTeamChannels,
  searchPosts,
  type MattermostPostList,
} from "./mattermost/client.js";

type MattermostClient = ReturnType<typeof createMattermostClient>;

function mockFetch(body: unknown, status = 200): typeof fetch {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

function clientWith(fetchImpl: typeof fetch): MattermostClient {
  return createMattermostClient({ baseUrl: "https://mm.test", botToken: "tok", fetchImpl });
}

const emptyPostList: MattermostPostList = { order: [], posts: {} };

function baseCfg(overrides?: Record<string, unknown>): OpenClawConfig {
  return {
    channels: {
      mattermost: { enabled: true, botToken: "tok", baseUrl: "https://mm.test", ...overrides },
    },
  };
}

describe("fetchChannelPosts", () => {
  it("builds URL with query params and returns posts", async () => {
    const data: MattermostPostList = {
      order: ["p1"],
      posts: { p1: { id: "p1", message: "hello" } },
    };
    const f = mockFetch(data);
    const result = await fetchChannelPosts(clientWith(f), "ch1", {
      limit: 10,
      before: "b",
      after: "a",
    });
    const url = (f as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toContain("/channels/ch1/posts");
    expect(url).toContain("per_page=10");
    expect(url).toContain("before=b");
    expect(result.posts.p1.message).toBe("hello");
  });

  it("propagates API errors", async () => {
    await expect(
      fetchChannelPosts(clientWith(mockFetch({ message: "Not found" }, 404)), "bad"),
    ).rejects.toThrow(/404.*Not found/);
  });
});

describe("searchPosts", () => {
  it("sends search terms with channel and author filters", async () => {
    const f = mockFetch(emptyPostList);
    await searchPosts(clientWith(f), "team1", "bug", { channelId: "dev", authorId: "alice" });
    const call = (f as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toContain("/teams/team1/posts/search");
    const body = JSON.parse(call[1].body as string);
    expect(body.terms).toBe("from:alice in:dev bug");
  });
});

describe("fetchTeamChannels", () => {
  it("fetches channels for team", async () => {
    const channels = [{ id: "c1", name: "general", type: "O" }];
    const f = mockFetch(channels);
    const result = await fetchTeamChannels(clientWith(f), "team1", { limit: 5 });
    const url = (f as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toContain("/teams/team1/channels");
    expect(url).toContain("per_page=5");
    expect(result[0].name).toBe("general");
  });
});

describe("createMattermostClient", () => {
  it("throws when baseUrl is empty", () => {
    expect(() => createMattermostClient({ baseUrl: "", botToken: "tok" })).toThrow(/baseUrl/);
  });

  it("sets auth header and extracts error messages", async () => {
    const f = mockFetch({ message: "Forbidden" }, 403);
    const client = clientWith(f);
    await expect(client.request("/test")).rejects.toThrow(/403.*Forbidden/);
    const headers = (f as ReturnType<typeof vi.fn>).mock.calls[0][1].headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer tok");
  });

  it("normalizes baseUrl variants", async () => {
    const f = mockFetch({ ok: true });
    const client = createMattermostClient({
      baseUrl: "https://mm.test/api/v4/",
      botToken: "tok",
      fetchImpl: f,
    });
    await client.request("/users/me");
    expect((f as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
      "https://mm.test/api/v4/users/me",
    );
  });
});

describe("mattermostMessageActions", () => {
  describe("listActions", () => {
    it("gates actions based on config", () => {
      const all = mattermostMessageActions.listActions!({ cfg: baseCfg() });
      expect(all).toContain("send");
      expect(all).toContain("read");
      expect(all).toContain("search");
      expect(all).toContain("channel-list");

      const gated = mattermostMessageActions.listActions!({
        cfg: baseCfg({ actions: { messages: false, search: false, channelInfo: false } }),
      });
      expect(gated).toEqual(["send"]);
    });

    it("returns empty when disabled", () => {
      expect(
        mattermostMessageActions.listActions!({
          cfg: { channels: { mattermost: { enabled: false } } },
        }),
      ).toEqual([]);
    });
  });

  describe("extractToolSend", () => {
    it("extracts send params", () => {
      expect(
        mattermostMessageActions.extractToolSend!({
          args: { action: "sendMessage", to: "#ch", accountId: "work" },
        }),
      ).toEqual({ to: "#ch", accountId: "work" });
    });

    it("returns null for non-send or invalid args", () => {
      expect(
        mattermostMessageActions.extractToolSend!({ args: { action: "read", to: "#ch" } }),
      ).toBeNull();
      expect(
        mattermostMessageActions.extractToolSend!({ args: { action: "sendMessage" } }),
      ).toBeNull();
    });
  });

  describe("handleAction", () => {
    let origFetch: typeof fetch;
    const stubFetch = (f: typeof fetch) => {
      origFetch = globalThis.fetch;
      globalThis.fetch = f;
    };
    afterEach(() => origFetch && (globalThis.fetch = origFetch));

    it("read fetches channel posts", async () => {
      const f = mockFetch(emptyPostList);
      stubFetch(f);
      await mattermostMessageActions.handleAction!({
        channel: "mattermost",
        action: "read",
        params: { channelId: "ch1", limit: 10 },
        cfg: baseCfg(),
      });
      const url = (f as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(url).toContain("/channels/ch1/posts");
    });

    it("search posts to team endpoint", async () => {
      const f = mockFetch(emptyPostList);
      stubFetch(f);
      await mattermostMessageActions.handleAction!({
        channel: "mattermost",
        action: "search",
        params: { query: "test", teamId: "t1" },
        cfg: baseCfg(),
      });
      expect((f as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain("/teams/t1/posts/search");
    });

    it("channel-list and channel-info work", async () => {
      const f = mockFetch([{ id: "c1", name: "general" }]);
      stubFetch(f);
      await mattermostMessageActions.handleAction!({
        channel: "mattermost",
        action: "channel-list",
        params: { teamId: "t1" },
        cfg: baseCfg(),
      });
      expect((f as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain("/teams/t1/channels");

      const f2 = mockFetch({ id: "c1", name: "general", type: "O" });
      stubFetch(f2);
      const result = await mattermostMessageActions.handleAction!({
        channel: "mattermost",
        action: "channel-info",
        params: { channelId: "c1" },
        cfg: baseCfg(),
      });
      expect((result.content as { text: string }[])[0].text).toContain("general");
    });

    it("validates required params", async () => {
      await expect(
        mattermostMessageActions.handleAction!({
          channel: "mattermost",
          action: "read",
          params: {},
          cfg: baseCfg(),
        }),
      ).rejects.toThrow(/to required/);

      await expect(
        mattermostMessageActions.handleAction!({
          channel: "mattermost",
          action: "search",
          params: { query: "x" },
          cfg: baseCfg(),
        }),
      ).rejects.toThrow(/teamId required/);
    });

    it("propagates API errors", async () => {
      stubFetch(mockFetch({ message: "Forbidden" }, 403));
      await expect(
        mattermostMessageActions.handleAction!({
          channel: "mattermost",
          action: "read",
          params: { to: "ch1" },
          cfg: baseCfg(),
        }),
      ).rejects.toThrow(/403.*Forbidden/);
    });
  });
});
