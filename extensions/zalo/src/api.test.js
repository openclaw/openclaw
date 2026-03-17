import { describe, expect, it, vi } from "vitest";
import { deleteWebhook, getWebhookInfo, sendChatAction } from "./api.js";
function createOkFetcher() {
  return vi.fn(async () => new Response(JSON.stringify({ ok: true, result: {} })));
}
async function expectPostJsonRequest(run) {
  const fetcher = createOkFetcher();
  await run("test-token", fetcher);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [, init] = fetcher.mock.calls[0] ?? [];
  expect(init?.method).toBe("POST");
  expect(init?.headers).toEqual({ "Content-Type": "application/json" });
}
describe("Zalo API request methods", () => {
  it("uses POST for getWebhookInfo", async () => {
    await expectPostJsonRequest(getWebhookInfo);
  });
  it("keeps POST for deleteWebhook", async () => {
    await expectPostJsonRequest(deleteWebhook);
  });
  it("aborts sendChatAction when the typing timeout elapses", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn(
        (_, init2) => new Promise((_2, reject) => {
          init2?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true
          });
        })
      );
      const promise = sendChatAction(
        "test-token",
        {
          chat_id: "chat-123",
          action: "typing"
        },
        fetcher,
        25
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
