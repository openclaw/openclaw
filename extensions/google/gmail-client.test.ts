import { describe, expect, it, vi } from "vitest";
import { createGmailClient } from "./gmail-client.js";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("createGmailClient", () => {
  it("lists messages with bearer auth", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ messages: [{ id: "m1", threadId: "t1" }] }));
    const client = createGmailClient({
      auth: { accessToken: "token-1" },
      fetchFn,
    });

    const result = await client.listMessages({ maxResults: 10, query: "in:inbox" });

    expect(result.messages?.[0]?.id).toBe("m1");
    expect(fetchFn).toHaveBeenCalledWith(
      expect.stringContaining("/messages?maxResults=10&q=in%3Ainbox"),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer token-1" }),
      }),
    );
  });

  it("creates a draft with encoded raw MIME", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ id: "draft-1" }));
    const client = createGmailClient({
      auth: { accessToken: "token-1" },
      fetchFn,
    });

    const result = await client.createDraft({
      to: "alex@example.com",
      subject: "Re: Hello",
      textBody: "Sounds good.",
      threadId: "thread-1",
    });

    expect(result.id).toBe("draft-1");
    expect(fetchFn).toHaveBeenCalledWith(
      expect.stringContaining("/drafts"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer token-1" }),
        body: expect.any(String),
      }),
    );
    const [, init] = fetchFn.mock.calls[0] as [string, { body: string }];
    const parsed = JSON.parse(init.body);
    expect(parsed.message.threadId).toBe("thread-1");
    expect(parsed.message.raw).toEqual(expect.any(String));
  });

  it("sends a message with encoded raw MIME", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ id: "sent-1", threadId: "thread-1" }));
    const client = createGmailClient({
      auth: { accessToken: "token-1" },
      fetchFn,
    });

    const result = await client.sendMessage({
      to: "alex@example.com",
      subject: "Hello",
      textBody: "Sent body",
      threadId: "thread-1",
    });

    expect(result.id).toBe("sent-1");
    expect(fetchFn).toHaveBeenCalledWith(
      expect.stringContaining("/messages/send"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer token-1" }),
        body: expect.any(String),
      }),
    );
    const [, init] = fetchFn.mock.calls[0] as [string, { body: string }];
    const parsed = JSON.parse(init.body);
    expect(parsed.threadId).toBe("thread-1");
    expect(parsed.raw).toEqual(expect.any(String));
  });

  it("refreshes an expired access token before calling Gmail when a refresh token exists", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(jsonResponse({ id: "m1", threadId: "t1" }));
    const refreshTokenFn = vi.fn().mockResolvedValue({
      access: "fresh-token",
      refresh: "refresh-1",
      expires: Date.now() + 3600_000,
    });
    const onTokenRefresh = vi.fn();

    const client = createGmailClient({
      auth: {
        accessToken: "expired-token",
        refreshToken: "refresh-1",
        expiresAt: Date.now() - 1000,
      },
      fetchFn,
      refreshTokenFn,
      onTokenRefresh,
    });

    const result = await client.getMessage("m1");

    expect(result.id).toBe("m1");
    expect(refreshTokenFn).toHaveBeenCalledWith({ refreshToken: "refresh-1" });
    expect(fetchFn).toHaveBeenCalledWith(
      expect.stringContaining("/messages/m1?format=full"),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer fresh-token" }),
      }),
    );
    expect(onTokenRefresh).toHaveBeenCalledTimes(1);
  });
});
