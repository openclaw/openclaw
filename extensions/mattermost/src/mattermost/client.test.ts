import { describe, expect, it, vi } from "vitest";
import { createMattermostClient, createMattermostPost } from "./client.js";

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

  describe("createMattermostPost", () => {
    it("includes root_id in payload when rootId is provided", async () => {
      const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
        return new Response(
          JSON.stringify({
            id: "new-post-id",
            channel_id: "CH1",
            message: "hello",
            root_id: "PARENT_POST",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });

      const client = createMattermostClient({
        baseUrl: "https://chat.example.com",
        botToken: "test-token",
        fetchImpl: fetchImpl as any,
      });

      await createMattermostPost(client, {
        channelId: "CH1",
        message: "hello",
        rootId: "PARENT_POST",
      });

      expect(fetchImpl).toHaveBeenCalledOnce();
      const [, init] = fetchImpl.mock.calls[0]!;
      const body = JSON.parse(init?.body as string);
      expect(body.root_id).toBe("PARENT_POST");
      expect(body.channel_id).toBe("CH1");
      expect(body.message).toBe("hello");
    });

    it("omits root_id from payload when rootId is not provided", async () => {
      const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
        return new Response(
          JSON.stringify({ id: "new-post-id", channel_id: "CH1", message: "hello" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });

      const client = createMattermostClient({
        baseUrl: "https://chat.example.com",
        botToken: "test-token",
        fetchImpl: fetchImpl as any,
      });

      await createMattermostPost(client, {
        channelId: "CH1",
        message: "hello",
      });

      const [, init] = fetchImpl.mock.calls[0]!;
      const body = JSON.parse(init?.body as string);
      expect(body.root_id).toBeUndefined();
    });
  });
});
