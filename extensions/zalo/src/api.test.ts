import { describe, expect, it, vi } from "vitest";
import { deleteWebhook, getWebhookInfo, type ZaloFetch } from "./api.js";

describe("Zalo API request methods", () => {
  it("uses POST for getWebhookInfo", async () => {
    const fetcher = vi.fn<ZaloFetch>(
      async () => new Response(JSON.stringify({ ok: true, result: {} })),
    );

    await getWebhookInfo("test-token", fetcher);

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [, init] = fetcher.mock.calls[0] ?? [];
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ "Content-Type": "application/json" });
  });

  it("keeps POST for deleteWebhook", async () => {
    const fetcher = vi.fn<ZaloFetch>(
      async () => new Response(JSON.stringify({ ok: true, result: {} })),
    );

    await deleteWebhook("test-token", fetcher);

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [, init] = fetcher.mock.calls[0] ?? [];
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ "Content-Type": "application/json" });
  });
});
