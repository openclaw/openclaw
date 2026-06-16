// Tests cover thread-history backfill mapping for restart/session-clear recovery (#93204).
import { describe, expect, it, vi } from "vitest";
import { createMattermostClient, fetchMattermostThread, type MattermostThread } from "./client.js";
import { buildThreadBackfillEntries, shouldBackfillThreadFromServer } from "./thread-backfill.js";

function thread(): MattermostThread {
  return {
    order: ["p1", "p2", "p3"],
    posts: {
      p1: { id: "p1", user_id: "u1", message: "what's the deploy plan?", create_at: 100 },
      p2: { id: "p2", user_id: "u2", message: "ship Friday", create_at: 200 },
      p3: { id: "p3", user_id: "u1", message: "@bot remind me", create_at: 300 },
    },
  };
}

describe("buildThreadBackfillEntries", () => {
  it("maps thread posts in order, skipping the current post", () => {
    const entries = buildThreadBackfillEntries({
      thread: thread(),
      currentPostId: "p3",
      limit: 10,
      resolveSenderLabel: (id) => (id === "u1" ? "alice" : id === "u2" ? "bob" : undefined),
    });
    expect(entries).toEqual([
      { sender: "alice", body: "what's the deploy plan?", timestamp: 100, messageId: "p1" },
      { sender: "bob", body: "ship Friday", timestamp: 200, messageId: "p2" },
    ]);
  });

  it("trims to the last `limit` entries", () => {
    const entries = buildThreadBackfillEntries({
      thread: thread(),
      limit: 1,
      resolveSenderLabel: () => undefined,
    });
    expect(entries).toHaveLength(1);
    // Last entry by order is p3.
    expect(entries[0]?.messageId).toBe("p3");
  });

  it("returns empty when limit <= 0", () => {
    expect(
      buildThreadBackfillEntries({
        thread: thread(),
        limit: 0,
        resolveSenderLabel: () => undefined,
      }),
    ).toEqual([]);
  });

  it("falls back to the user id when no display name resolves", () => {
    const entries = buildThreadBackfillEntries({
      thread: { order: ["a"], posts: { a: { id: "a", user_id: "u9", message: "hi" } } },
      limit: 10,
      resolveSenderLabel: () => undefined,
    });
    expect(entries[0]?.sender).toBe("u9");
  });

  it("skips system posts and empty (no body, no files) posts", () => {
    const entries = buildThreadBackfillEntries({
      thread: {
        order: ["sys", "empty", "real"],
        posts: {
          sys: { id: "sys", user_id: "u1", message: "joined", type: "system_join_channel" },
          empty: { id: "empty", user_id: "u1", message: "" },
          real: { id: "real", user_id: "u1", message: "actual content" },
        },
      },
      limit: 10,
      resolveSenderLabel: () => "alice",
      isSystemPost: (p) => typeof p.type === "string" && p.type.startsWith("system_"),
    });
    expect(entries).toEqual([
      { sender: "alice", body: "actual content", timestamp: undefined, messageId: "real" },
    ]);
  });

  it("renders a file placeholder for attachment-only posts", () => {
    const entries = buildThreadBackfillEntries({
      thread: {
        order: ["f"],
        posts: { f: { id: "f", user_id: "u1", message: "", file_ids: ["x", "y"] } },
      },
      limit: 10,
      resolveSenderLabel: () => "alice",
    });
    expect(entries[0]?.body).toBe("[Mattermost files]");
  });

  it("tolerates missing order/posts", () => {
    expect(
      buildThreadBackfillEntries({ thread: {}, limit: 5, resolveSenderLabel: () => undefined }),
    ).toEqual([]);
  });
});

describe("shouldBackfillThreadFromServer", () => {
  it("backfills on the first empty-window sighting of a thread root (recovery)", () => {
    const seen = new Set<string>();
    expect(
      shouldBackfillThreadFromServer({
        threadRootId: "root1",
        historyLimit: 10,
        currentWindowSize: 0,
        seenThreadRoots: seen,
      }),
    ).toBe(true);
    expect(seen.has("root1")).toBe(true);
  });

  it("does NOT rehydrate an active thread whose window the kernel cleared post-turn", () => {
    // Regression for ClawSweeper P1: the turn kernel clears the pending-history
    // window after every successful dispatch, so a later empty window for a
    // root we already serviced is steady state, not restart recovery.
    const seen = new Set<string>();
    // First mention: window built then cleared by the kernel -> recovery fires once.
    expect(
      shouldBackfillThreadFromServer({
        threadRootId: "root1",
        historyLimit: 10,
        currentWindowSize: 0,
        seenThreadRoots: seen,
      }),
    ).toBe(true);
    // Follow-up mention in the SAME active thread, window emptied by the kernel:
    // must NOT fetch/rehydrate the whole server thread again.
    expect(
      shouldBackfillThreadFromServer({
        threadRootId: "root1",
        historyLimit: 10,
        currentWindowSize: 0,
        seenThreadRoots: seen,
      }),
    ).toBe(false);
  });

  it("does not backfill when the window already has in-memory context", () => {
    const seen = new Set<string>();
    expect(
      shouldBackfillThreadFromServer({
        threadRootId: "root1",
        historyLimit: 10,
        currentWindowSize: 3,
        seenThreadRoots: seen,
      }),
    ).toBe(false);
    // Root is still marked serviced so a later empty window can't trigger recovery.
    expect(seen.has("root1")).toBe(true);
    expect(
      shouldBackfillThreadFromServer({
        threadRootId: "root1",
        historyLimit: 10,
        currentWindowSize: 0,
        seenThreadRoots: seen,
      }),
    ).toBe(false);
  });

  it("never backfills without a thread root or with history disabled", () => {
    const seen = new Set<string>();
    expect(
      shouldBackfillThreadFromServer({
        threadRootId: undefined,
        historyLimit: 10,
        currentWindowSize: 0,
        seenThreadRoots: seen,
      }),
    ).toBe(false);
    expect(
      shouldBackfillThreadFromServer({
        threadRootId: "root1",
        historyLimit: 0,
        currentWindowSize: 0,
        seenThreadRoots: seen,
      }),
    ).toBe(false);
    // Neither no-op call should mark a root as serviced.
    expect(seen.size).toBe(0);
  });
});

describe("fetchMattermostThread", () => {
  it("requests GET /posts/{rootId}/thread and parses the payload", async () => {
    const calls: string[] = [];
    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      calls.push(typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url);
      return new Response(
        JSON.stringify({ order: ["p1"], posts: { p1: { id: "p1", message: "hi" } } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const client = createMattermostClient({
      baseUrl: "http://localhost:8065",
      botToken: "tok",
      fetchImpl: mockFetch as typeof fetch,
    });
    const result = await fetchMattermostThread(client, "root123");
    expect(calls[0]).toContain("/posts/root123/thread");
    expect(result.order).toEqual(["p1"]);
    expect(result.posts?.p1?.message).toBe("hi");
  });
});
