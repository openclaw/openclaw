import { createHash } from "node:crypto";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("./runtime.js", () => ({
  getInfoflowRuntime: vi.fn(() => ({
    logging: { shouldLogVerbose: () => false },
  })),
}));

vi.mock("./infoflow-req-parse.js", () => ({
  recordSentMessageId: vi.fn(),
}));

import { getAppAccessToken, _resetTokenCache } from "./send.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();

function mockTokenResponse(token: string, expiresIn = 7200) {
  return {
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        errcode: 0,
        data: { app_access_token: token, expires_in: expiresIn },
      }),
  };
}

const BASE_PARAMS = {
  apiHost: "https://api.example.com",
  appKey: "test-key",
  appSecret: "test-secret",
};

beforeEach(() => {
  _resetTokenCache();
  vi.stubGlobal("fetch", mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ============================================================================
// getAppAccessToken
// ============================================================================

// ============================================================================
// sendInfoflowMessage
// ============================================================================

vi.mock("./accounts.js", () => ({
  resolveInfoflowAccount: vi.fn(({ accountId }: { accountId?: string }) => ({
    accountId: accountId ?? "default",
    config: {
      apiHost: "https://api.example.com",
      appKey: "test-key",
      appSecret: "test-secret",
    },
  })),
}));

import { sendInfoflowMessage } from "./send.js";

describe("sendInfoflowMessage", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("returns error when contents array is empty", async () => {
    const result = await sendInfoflowMessage({
      cfg: {} as never,
      to: "user1",
      contents: [],
    });
    expect(result).toEqual({ ok: false, error: "contents array is empty" });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("routes to private message for username target", async () => {
    // Mock token + private send
    mockFetch.mockResolvedValueOnce(mockTokenResponse("tok-1")).mockResolvedValueOnce({
      ok: true,
      text: () =>
        Promise.resolve(JSON.stringify({ code: "ok", data: { errcode: 0, msgkey: "msg-123" } })),
    });

    const result = await sendInfoflowMessage({
      cfg: {} as never,
      to: "chengbo05",
      contents: [{ type: "text", content: "hello" }],
    });

    expect(result.ok).toBe(true);
    expect(result.messageId).toBe("msg-123");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("routes to group message for group:123 target", async () => {
    // Mock token + group send
    mockFetch.mockResolvedValueOnce(mockTokenResponse("tok-1")).mockResolvedValueOnce({
      ok: true,
      text: () =>
        Promise.resolve(
          JSON.stringify({ code: "ok", data: { errcode: 0, data: { messageid: "grp-456" } } }),
        ),
    });

    const result = await sendInfoflowMessage({
      cfg: {} as never,
      to: "group:12345",
      contents: [{ type: "markdown", content: "# Title" }],
    });

    expect(result.ok).toBe(true);
    expect(result.messageId).toBe("grp-456");
  });

  it("sends private message with link using richtext format", async () => {
    mockFetch.mockResolvedValueOnce(mockTokenResponse("tok-1")).mockResolvedValueOnce({
      ok: true,
      text: () =>
        Promise.resolve(
          JSON.stringify({ code: "ok", data: { errcode: 0, msgkey: "msg-link-123" } }),
        ),
    });

    const result = await sendInfoflowMessage({
      cfg: {} as never,
      to: "user1",
      contents: [
        { type: "text", content: "Check this link:" },
        { type: "link", content: "[Example]https://example.com" },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.messageId).toBe("msg-link-123");

    // Verify richtext payload
    const [, opts] = mockFetch.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    expect(body.msgtype).toBe("richtext");
    expect(body.richtext).toEqual({
      content: [
        { type: "text", text: "Check this link:" },
        { type: "a", href: "https://example.com", label: "Example" },
      ],
    });
  });

  it("sends private link with href only (no label)", async () => {
    mockFetch.mockResolvedValueOnce(mockTokenResponse("tok-1")).mockResolvedValueOnce({
      ok: true,
      text: () =>
        Promise.resolve(JSON.stringify({ code: "ok", data: { errcode: 0, msgkey: "msg-456" } })),
    });

    await sendInfoflowMessage({
      cfg: {} as never,
      to: "user1",
      contents: [{ type: "link", content: "https://example.com" }],
    });

    const [, opts] = mockFetch.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    expect(body.msgtype).toBe("richtext");
    expect(body.richtext).toEqual({
      content: [{ type: "a", href: "https://example.com", label: "https://example.com" }],
    });
  });

  it("sends group message with link in body", async () => {
    mockFetch.mockResolvedValueOnce(mockTokenResponse("tok-1")).mockResolvedValueOnce({
      ok: true,
      text: () =>
        Promise.resolve(
          JSON.stringify({ code: "ok", data: { errcode: 0, data: { messageid: "grp-link-789" } } }),
        ),
    });

    const result = await sendInfoflowMessage({
      cfg: {} as never,
      to: "group:12345",
      contents: [
        { type: "text", content: "Visit:" },
        { type: "link", content: "[Docs]https://docs.example.com" },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.messageId).toBe("grp-link-789");

    // Verify group message body includes LINK item
    const [, opts] = mockFetch.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as { message: { body: unknown[] } };
    expect(body.message.body).toEqual([
      { type: "TEXT", content: "Visit:" },
      { type: "LINK", href: "https://docs.example.com" },
    ]);
  });
});

// ============================================================================
// getAppAccessToken
// ============================================================================

describe("getAppAccessToken", () => {
  it("fetches token on cache miss", async () => {
    mockFetch.mockResolvedValueOnce(mockTokenResponse("tok-abc"));
    const result = await getAppAccessToken(BASE_PARAMS);
    expect(result).toEqual({ ok: true, token: "tok-abc" });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("sends MD5-hashed appSecret in request body", async () => {
    mockFetch.mockResolvedValueOnce(mockTokenResponse("tok-1"));
    await getAppAccessToken(BASE_PARAMS);
    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as Record<string, string>;
    const expectedMd5 = createHash("md5").update("test-secret").digest("hex").toLowerCase();
    expect(body.app_secret).toBe(expectedMd5);
  });

  it("returns cached token on second call", async () => {
    mockFetch.mockResolvedValueOnce(mockTokenResponse("tok-cached"));
    await getAppAccessToken(BASE_PARAMS);
    const result = await getAppAccessToken(BASE_PARAMS);
    expect(result).toEqual({ ok: true, token: "tok-cached" });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("refetches after cache expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
    mockFetch.mockResolvedValueOnce(mockTokenResponse("tok-1", 600));
    await getAppAccessToken(BASE_PARAMS);
    vi.advanceTimersByTime(301 * 1000); // past (600-300)s buffer
    mockFetch.mockResolvedValueOnce(mockTokenResponse("tok-2", 600));
    const result = await getAppAccessToken(BASE_PARAMS);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.token).toBe("tok-2");
  });

  it("isolates cache by appKey (multi-account)", async () => {
    mockFetch
      .mockResolvedValueOnce(mockTokenResponse("tok-A"))
      .mockResolvedValueOnce(mockTokenResponse("tok-B"));
    const resultA = await getAppAccessToken({ ...BASE_PARAMS, appKey: "key-A" });
    const resultB = await getAppAccessToken({ ...BASE_PARAMS, appKey: "key-B" });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(resultA.token).toBe("tok-A");
    expect(resultB.token).toBe("tok-B");
  });

  it("handles network error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const result = await getAppAccessToken(BASE_PARAMS);
    expect(result).toEqual({ ok: false, error: "ECONNREFUSED" });
  });
});
