import { describe, expect, it, vi } from "vitest";
import { createMattermostClient } from "./client.js";

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
});
