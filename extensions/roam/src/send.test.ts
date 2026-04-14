import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendMessageRoam, sendTypingRoam } from "./send.js";

const { mockResolveRoamAccount } = vi.hoisted(() => ({
  mockResolveRoamAccount: vi.fn(),
}));

const mockActivityRecord = vi.fn();

vi.mock("./accounts.js", () => ({
  resolveRoamAccount: mockResolveRoamAccount,
}));

vi.mock("./runtime.js", () => ({
  getRoamRuntime: () => ({
    config: { loadConfig: () => ({}) },
    channel: {
      text: {
        resolveMarkdownTableMode: () => "preserve",
        convertMarkdownTables: (text: string) => text,
      },
      activity: { record: mockActivityRecord },
    },
  }),
}));

const mockFetchInner = vi.fn();
const mockFetchWithSsrFGuard = vi.fn(async (params: { url: string; init?: RequestInit }) => {
  const response = await mockFetchInner(params.url, params.init);
  return { response, finalUrl: params.url, release: vi.fn() };
});

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: (...args: unknown[]) => mockFetchWithSsrFGuard(args[0] as never),
}));

function defaultAccount(overrides?: Record<string, unknown>) {
  return {
    accountId: "default",
    enabled: true,
    apiKey: "test-api-key",
    apiKeySource: "config" as const,
    config: {},
    ...overrides,
  };
}

describe("sendMessageRoam", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveRoamAccount.mockReturnValue(defaultAccount());
    mockFetchInner.mockResolvedValue({
      ok: true,
      json: async () => ({ chat: "chat-1", timestamp: 1000 }),
    });
  });

  it("posts to /v1/chat.post with correct headers and body", async () => {
    await sendMessageRoam("chat-1", "hello world");

    expect(mockFetchInner).toHaveBeenCalledOnce();
    const [url, opts] = mockFetchInner.mock.calls[0];
    expect(url).toBe("https://api.ro.am/v1/chat.post");
    expect(opts.method).toBe("POST");
    expect(opts.headers.Authorization).toBe("Bearer test-api-key");
    expect(opts.headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(opts.body);
    expect(body.chatId).toBe("chat-1");
    expect(body.text).toBe("hello world");
    expect(body.markdown).toBe(true);
    expect(body.sync).toBe(true);
  });

  it("includes threadKey when provided", async () => {
    await sendMessageRoam("chat-1", "hello", { threadKey: "thread-abc" });

    const body = JSON.parse(mockFetchInner.mock.calls[0][1].body);
    expect(body.threadKey).toBe("thread-abc");
  });

  it("truncates threadKey to 64 chars", async () => {
    const longKey = "a".repeat(100);
    await sendMessageRoam("chat-1", "hello", { threadKey: longKey });

    const body = JSON.parse(mockFetchInner.mock.calls[0][1].body);
    expect(body.threadKey).toHaveLength(64);
  });

  it("strips roam: target prefix from chatId", async () => {
    await sendMessageRoam("roam:group:chat-1", "hello");

    const body = JSON.parse(mockFetchInner.mock.calls[0][1].body);
    expect(body.chatId).toBe("chat-1");
  });

  it("throws on empty text", async () => {
    await expect(sendMessageRoam("chat-1", "   ")).rejects.toThrow("non-empty");
  });

  it("throws on empty chatId", async () => {
    await expect(sendMessageRoam("", "hello")).rejects.toThrow("Chat ID is required");
  });

  it("throws on missing API key", async () => {
    mockResolveRoamAccount.mockReturnValue(defaultAccount({ apiKey: "" }));
    await expect(sendMessageRoam("chat-1", "hello")).rejects.toThrow("API key missing");
  });

  it("maps HTTP 401 to auth error", async () => {
    mockFetchInner.mockResolvedValueOnce({ ok: false, status: 401, text: async () => "" });
    await expect(sendMessageRoam("chat-1", "hello")).rejects.toThrow("authentication failed");
  });

  it("maps HTTP 403 to forbidden error", async () => {
    mockFetchInner.mockResolvedValueOnce({ ok: false, status: 403, text: async () => "" });
    await expect(sendMessageRoam("chat-1", "hello")).rejects.toThrow("forbidden");
  });

  it("maps HTTP 404 to chat-not-found error", async () => {
    mockFetchInner.mockResolvedValueOnce({ ok: false, status: 404, text: async () => "" });
    await expect(sendMessageRoam("chat-1", "hello")).rejects.toThrow("chat not found");
  });

  it("maps HTTP 413 to size-limit error", async () => {
    mockFetchInner.mockResolvedValueOnce({ ok: false, status: 413, text: async () => "" });
    await expect(sendMessageRoam("chat-1", "hello")).rejects.toThrow("too large");
  });

  it("records outbound activity", async () => {
    await sendMessageRoam("chat-1", "hello");

    expect(mockActivityRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "roam",
        accountId: "default",
        direction: "outbound",
      }),
    );
  });

  it("returns chatId and timestamp from response", async () => {
    const result = await sendMessageRoam("chat-1", "hello");
    expect(result.chatId).toBe("chat-1");
    expect(result.timestamp).toBe(1000);
  });

  it("uses custom apiBaseUrl from config", async () => {
    await sendMessageRoam("chat-1", "hello", {
      cfg: { channels: { roam: { apiBaseUrl: "https://api.roam.dev" } } },
    });

    const [url] = mockFetchInner.mock.calls[0];
    expect(url).toBe("https://api.roam.dev/v1/chat.post");
  });

  it("uses per-account apiBaseUrl over top-level config", async () => {
    mockResolveRoamAccount.mockReturnValue(
      defaultAccount({ config: { apiBaseUrl: "https://api.account.dev" } }),
    );
    await sendMessageRoam("chat-1", "hello", {
      cfg: { channels: { roam: { apiBaseUrl: "https://api.toplevel.dev" } } },
    });

    const [url] = mockFetchInner.mock.calls[0];
    expect(url).toBe("https://api.account.dev/v1/chat.post");
  });
});

describe("sendTypingRoam", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveRoamAccount.mockReturnValue(defaultAccount());
    mockFetchInner.mockResolvedValue({ ok: true });
  });

  it("posts to /v1/chat.typing with chatId", async () => {
    await sendTypingRoam("chat-1");

    expect(mockFetchInner).toHaveBeenCalledOnce();
    const [url, opts] = mockFetchInner.mock.calls[0];
    expect(url).toBe("https://api.ro.am/v1/chat.typing");
    const body = JSON.parse(opts.body);
    expect(body.chatId).toBe("chat-1");
  });

  it("strips target prefix", async () => {
    await sendTypingRoam("roam:chat-1");

    const body = JSON.parse(mockFetchInner.mock.calls[0][1].body);
    expect(body.chatId).toBe("chat-1");
  });

  it("swallows fetch errors", async () => {
    mockFetchInner.mockRejectedValueOnce(new Error("network error"));
    await expect(sendTypingRoam("chat-1")).resolves.toBeUndefined();
  });
});
