import { describe, expect, it, vi } from "vitest";
import { createMattermostTestConfig } from "./reactions.test-helpers.js";
import { readMattermostMessages } from "./read.js";

/**
 * Build a mock fetch that responds to Mattermost channel-posts and user-lookup endpoints.
 */
function createReadFetchMock(opts?: {
  posts?: Array<{ id: string; user_id: string; message: string; create_at?: number }>;
  users?: Record<string, { id: string; username?: string }>;
  postsStatus?: number;
}) {
  const posts = opts?.posts ?? [
    { id: "p1", user_id: "u1", message: "hello", create_at: 1000 },
    { id: "p2", user_id: "u2", message: "world", create_at: 2000 },
  ];
  const users: Record<string, { id: string; username?: string }> = opts?.users ?? {
    u1: { id: "u1", username: "alice" },
    u2: { id: "u2", username: "bob" },
  };
  const postsStatus = opts?.postsStatus ?? 200;

  const order = posts.map((p) => p.id);
  const postsMap = Object.fromEntries(posts.map((p) => [p.id, p]));

  return vi.fn(async (url: any, _init?: any) => {
    const urlStr = String(url);

    // Channel posts endpoint
    if (urlStr.includes("/api/v4/channels/") && urlStr.includes("/posts")) {
      if (postsStatus !== 200) {
        return new Response(JSON.stringify({ message: "error" }), {
          status: postsStatus,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ order, posts: postsMap }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    // User lookup endpoint
    const userMatch = urlStr.match(/\/api\/v4\/users\/([^/?]+)$/);
    if (userMatch) {
      const userId = userMatch[1];
      const user = users[userId];
      if (user) {
        return new Response(JSON.stringify(user), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ message: "user not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }

    throw new Error(`Unexpected URL: ${urlStr}`);
  });
}

describe("readMattermostMessages", () => {
  it("returns messages with resolved usernames", async () => {
    const fetchMock = createReadFetchMock();
    const result = await readMattermostMessages({
      cfg: createMattermostTestConfig(),
      channelId: "CH1",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toMatchObject({
      id: "p1",
      userId: "u1",
      username: "alice",
      message: "hello",
    });
    expect(result.messages[1]).toMatchObject({
      id: "p2",
      userId: "u2",
      username: "bob",
      message: "world",
    });
    expect(result.hasMore).toBe(false);
  });

  it("deduplicates username lookups for same user", async () => {
    const posts = [
      { id: "p1", user_id: "u1", message: "first", create_at: 1000 },
      { id: "p2", user_id: "u1", message: "second", create_at: 2000 },
      { id: "p3", user_id: "u1", message: "third", create_at: 3000 },
    ];
    const fetchMock = createReadFetchMock({
      posts,
      users: { u1: { id: "u1", username: "alice" } },
    });

    const result = await readMattermostMessages({
      cfg: createMattermostTestConfig(),
      channelId: "CH1",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result.messages).toHaveLength(3);
    expect(result.messages.every((m) => m.username === "alice")).toBe(true);

    // Only one user lookup should have been made despite 3 posts from same user
    const userCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/api/v4/users/u1"));
    expect(userCalls).toHaveLength(1);
  });

  it("handles user lookup failures gracefully", async () => {
    const fetchMock = createReadFetchMock({
      posts: [{ id: "p1", user_id: "u-gone", message: "orphan", create_at: 1000 }],
      users: {},
    });

    const result = await readMattermostMessages({
      cfg: createMattermostTestConfig(),
      channelId: "CH1",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].username).toBeUndefined();
    expect(result.messages[0].message).toBe("orphan");
  });

  it("throws when botToken or baseUrl is missing", async () => {
    await expect(
      readMattermostMessages({
        cfg: { channels: { mattermost: { enabled: true } } },
        channelId: "CH1",
      }),
    ).rejects.toThrow("botToken/baseUrl missing");
  });

  it("passes pagination params through to the API", async () => {
    const fetchMock = createReadFetchMock({ posts: [] });
    await readMattermostMessages({
      cfg: createMattermostTestConfig(),
      channelId: "CH1",
      limit: 10,
      before: "beforeId",
      after: "afterId",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const postsCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("/posts"));
    expect(postsCall).toBeDefined();
    const url = String(postsCall![0]);
    expect(url).toContain("per_page=10");
    expect(url).toContain("before=beforeId");
    expect(url).toContain("after=afterId");
  });
});
