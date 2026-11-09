// Feishu streaming start retries preserve accepted-card behavior without replaying entity creation.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeishuStreamingSession } from "./streaming-card.js";
import {
  createMemoryFetch,
  createStreamingSession,
  jsonResponse,
  mockAcceptedStreamingCard,
} from "./streaming-card.test-support.js";

describe("FeishuStreamingSession", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([
    { mode: "create", options: undefined, method: "create" },
    { mode: "root_create", options: { rootId: "root_1" }, method: "create" },
    {
      mode: "reply",
      options: { replyToMessageId: "inbound_1", replyInThread: true, rootId: "root_1" },
      method: "reply",
    },
  ] as const)(
    "retries, updates and closes an accepted $mode card without its optional message receipt",
    async ({ mode, options, method }) => {
      vi.useFakeTimers();
      const { session, requests, create, reply } = mockAcceptedStreamingCard({
        accountId: `accepted-without-receipt-${mode}`,
      });

      const send = method === "reply" ? reply : create;
      send.mockRejectedValueOnce(
        Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
      );
      const started = session.start("chat_1", "chat_id", options);
      const accepted = expect(started).resolves.toBeUndefined();
      await vi.runAllTimersAsync();
      await accepted;
      await session.update("The accepted answer");

      await expect(session.closeWithResult("The accepted answer")).resolves.toEqual({
        visibleReplySent: true,
        content: "The accepted answer",
      });
      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[1]).toEqual(send.mock.calls[0]);
      expect(method === "reply" ? create : reply).not.toHaveBeenCalled();
      if (mode === "root_create") {
        expect(create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ root_id: "root_1" }),
          }),
        );
      } else if (mode === "create") {
        expect(create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.not.objectContaining({ root_id: expect.anything() }),
          }),
        );
      } else {
        expect(reply).toHaveBeenCalledWith(
          expect.objectContaining({
            path: { message_id: "inbound_1" },
            data: expect.objectContaining({ reply_in_thread: true }),
          }),
        );
      }
      expect(requests.map(({ path }) => path)).toEqual([
        "/open-apis/cardkit/v1/cards/card_accepted/elements/content/content",
        "/open-apis/cardkit/v1/cards/card_accepted/settings",
      ]);
      expect(session.isActive()).toBe(false);
    },
  );

  it("does not replay ambiguous CardKit entity creation", async () => {
    let creates = 0;
    const deps = createMemoryFetch((url) => {
      if (url.pathname.includes("/auth/")) {
        return jsonResponse({ code: 0, tenant_access_token: "token", expire: 7200 });
      }
      creates += 1;
      throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    });
    const create = vi.fn();
    const session = createStreamingSession(
      { im: { message: { create } } } as unknown as ConstructorParameters<
        typeof FeishuStreamingSession
      >[0],
      { appId: "non-replay-card-create", appSecret: "test-secret" },
      undefined,
      deps,
    );

    await expect(session.start("chat_1")).rejects.toThrow("socket hang up");
    expect(creates).toBe(1);
    expect(create).not.toHaveBeenCalled();
    expect(session.isActive()).toBe(false);
  });
});
