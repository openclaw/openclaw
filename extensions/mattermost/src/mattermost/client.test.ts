import { describe, expect, it, vi } from "vitest";
import { createMattermostClient, fetchMattermostChannelPosts } from "./client.js";

describe("mattermost client", () => {
  it("request returns undefined on 204 responses", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(null, { status: 204 });
    });

    const client = createMattermostClient({
      baseUrl: "https://chat.example.com",
      botToken: "test-token",
      fetchImpl: fetchImpl as any,
    });

    const result = await client.request<unknown>("/anything", { method: "DELETE" });
    expect(result).toBeUndefined();
  });

  it("fetchMattermostChannelPosts parses post list and returns ordered messages", async () => {
    const postsData = {
      order: ["p2", "p1"],
      posts: {
        p1: { id: "p1", user_id: "u1", message: "first" },
        p2: { id: "p2", user_id: "u2", message: "second" },
      },
    };

    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
      return new Response(JSON.stringify(postsData), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const client = createMattermostClient({
      baseUrl: "https://chat.example.com",
      botToken: "test-token",
      fetchImpl: fetchImpl as any,
    });

    const result = await fetchMattermostChannelPosts(client, "CH1", { limit: 10 });
    expect(result.messages).toHaveLength(2);
    // Order should match the `order` array (newest first)
    expect(result.messages[0].id).toBe("p2");
    expect(result.messages[1].id).toBe("p1");
    expect(result.hasMore).toBe(false);

    // Verify URL includes per_page param
    const url = String(fetchImpl.mock.calls[0]![0]);
    expect(url).toContain("/channels/CH1/posts");
    expect(url).toContain("per_page=10");
  });

  it("fetchMattermostChannelPosts caps limit at 200", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
      return new Response(JSON.stringify({ order: [], posts: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const client = createMattermostClient({
      baseUrl: "https://chat.example.com",
      botToken: "test-token",
      fetchImpl: fetchImpl as any,
    });

    await fetchMattermostChannelPosts(client, "CH1", { limit: 500 });
    const url = String(fetchImpl.mock.calls[0]![0]);
    expect(url).toContain("per_page=200");
  });
});
