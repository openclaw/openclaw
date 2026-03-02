import { describe, expect, it, vi } from "vitest";
import { createMattermostClient, patchMattermostPost } from "./client.js";

describe("mattermost client", () => {
  it("request returns undefined on 204 responses", async () => {
    const fetchImpl = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(async () => {
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

  it("patchMattermostPost updates a post via /patch endpoint", async () => {
    const fetchImpl = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(async () => {
      return new Response(JSON.stringify({ id: "post-123", message: "updated" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const client = createMattermostClient({
      baseUrl: "https://chat.example.com",
      botToken: "test-token",
      fetchImpl: fetchImpl as any,
    });

    const post = await patchMattermostPost(client, {
      postId: "post-123",
      message: "updated",
    });

    expect(post).toMatchObject({ id: "post-123", message: "updated" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://chat.example.com/api/v4/posts/post-123/patch");
    expect(init).toBeDefined();
    if (!init) {
      throw new Error("expected fetch init for patch request");
    }
    expect(init.method).toBe("PUT");
    expect(String(init.body)).toBe(JSON.stringify({ message: "updated" }));
  });
});
