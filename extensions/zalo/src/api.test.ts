import { describe, expect, it, vi } from "vitest";
import { deleteWebhook, getWebhookInfo, sendChatAction, type ZaloFetch } from "./api.js";

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

  it("aborts sendChatAction when the typing timeout elapses", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn<ZaloFetch>(
        (_, init) =>
          new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
          }),
      );

      const promise = sendChatAction(
        "test-token",
        {
          chat_id: "chat-123",
          action: "typing",
        },
        fetcher,
        25,
      );
      const rejected = expect(promise).rejects.toThrow("aborted");

      await vi.advanceTimersByTimeAsync(25);

      await rejected;
      const [, init] = fetcher.mock.calls[0] ?? [];
      expect(init?.signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
