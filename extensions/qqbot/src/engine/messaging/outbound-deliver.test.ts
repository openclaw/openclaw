// Tests cover chunk-merge behavior in outbound delivery.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ApiError, type GatewayAccount } from "../types.js";
import { QQBOT_MARKDOWN_SAFE_CHUNK_BYTE_LIMIT } from "./markdown-table-chunking.js";
import { sendTextOnlyReply } from "./outbound-deliver.js";

// ─── Mocks ──────────────────────────────────────────────────────────────────

const sendTextMock = vi.hoisted(() =>
  vi.fn(async (..._params: unknown[]) => ({
    id: "text-1",
    timestamp: "2026-07-01T00:00:00.000Z",
  })),
);

vi.mock("./sender.js", () => ({
  accountToCreds: (account: GatewayAccount) => ({
    appId: account.appId,
    clientSecret: account.clientSecret,
  }),
  buildDeliveryTarget: (target: { type: string; senderId: string; groupOpenid?: string }) => ({
    type: target.type === "group" ? "group" : "c2c",
    id: target.type === "group" ? target.groupOpenid : target.senderId,
  }),
  initApiConfig: vi.fn(),
  sendFileMessage: vi.fn(),
  sendImage: vi.fn(),
  sendText: sendTextMock,
  sendVideoMessage: vi.fn(),
  sendVoiceMessage: vi.fn(),
  sendMedia: vi.fn(),
  withTokenRetry: async (_creds: unknown, fn: () => Promise<unknown>) => await fn(),
}));

// ─── Fixtures ───────────────────────────────────────────────────────────────

const account: GatewayAccount = {
  accountId: "qq-main",
  appId: "app",
  clientSecret: "secret",
  markdownSupport: false,
  config: {},
};

const event = {
  type: "c2c" as const,
  senderId: "user-openid",
  messageId: "msg-1",
};

const actx = {
  account,
  qualifiedTarget: "qqbot:c2c:user-openid",
};

const sendWithRetry: <T>(fn: (token: string) => Promise<T>) => Promise<T> = async (fn) =>
  await fn("fake-token");

function consumeQuoteRef(): string | undefined {
  return undefined;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("sendTextOnlyReply chunk merging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("merges multiple chunks into a single send when merged size fits within the safe byte limit", async () => {
    // chunkText returns two small chunks that easily fit within 3600 bytes.
    const deps = {
      mediaSender: {} as Parameters<typeof sendTextOnlyReply>[5]["mediaSender"],
      chunkText: (_text: string, _limit: number) => [
        "Short paragraph one.",
        "Short paragraph two.",
      ],
    };

    await sendTextOnlyReply(
      "Short paragraph one.\n\nShort paragraph two.",
      event,
      actx,
      sendWithRetry,
      consumeQuoteRef,
      deps,
    );

    // Only one sendText call because the two chunks were merged.
    expect(sendTextMock).toHaveBeenCalledTimes(1);
    const sentText = sendTextMock.mock.calls[0]?.[1] as string | undefined;
    expect(sentText).toBe("Short paragraph one.\n\nShort paragraph two.");
  });

  it("keeps chunks separate when merged size exceeds the safe byte limit", async () => {
    // chunkText returns two chunks whose merged total exceeds 3600 bytes.
    // largeChunk at (limit - 50) bytes plus "\n\n" plus second chunk pushes over.
    const largeChunk = "A".repeat(QQBOT_MARKDOWN_SAFE_CHUNK_BYTE_LIMIT - 50);
    const secondChunk = "Another paragraph that pushes the merge over the limit.";
    const deps = {
      mediaSender: {} as Parameters<typeof sendTextOnlyReply>[5]["mediaSender"],
      chunkText: (_text: string, _limit: number) => [largeChunk, secondChunk],
    };

    // Must not throw — overflow falls back to separate sends without errors.
    await expect(
      sendTextOnlyReply(
        `${largeChunk}\n\n${secondChunk}`,
        event,
        actx,
        sendWithRetry,
        consumeQuoteRef,
        deps,
      ),
    ).resolves.toBeUndefined();

    // Two separate sendText calls because merging would exceed the byte limit.
    expect(sendTextMock).toHaveBeenCalledTimes(2);
    // Each original chunk is sent as-is.
    expect(sendTextMock.mock.calls[0]?.[1]).toBe(largeChunk);
    expect(sendTextMock.mock.calls[1]?.[1]).toBe(secondChunk);
  });

  it("merges chunks when total size is exactly at the safe byte limit", async () => {
    // Two chunks whose merged size equals exactly 3600 bytes: still within <= limit.
    const chunk1 = "A".repeat(2000);
    const chunk2 = "B".repeat(QQBOT_MARKDOWN_SAFE_CHUNK_BYTE_LIMIT - 2000 - 2); // minus "\n\n"
    const deps = {
      mediaSender: {} as Parameters<typeof sendTextOnlyReply>[5]["mediaSender"],
      chunkText: (_text: string, _limit: number) => [chunk1, chunk2],
    };

    await sendTextOnlyReply(
      `${chunk1}\n\n${chunk2}`,
      event,
      actx,
      sendWithRetry,
      consumeQuoteRef,
      deps,
    );

    // Merged into a single send because total === limit.
    expect(sendTextMock).toHaveBeenCalledTimes(1);
    expect(sendTextMock.mock.calls[0]?.[1]).toBe(`${chunk1}\n\n${chunk2}`);
  });

  it("falls back to separate sends for three or more chunks whose merged total overflows", async () => {
    // Three chunks: first two are large, third pushes the merge well over 3600.
    const chunk1 = "A".repeat(2000);
    const chunk2 = "B".repeat(1500);
    const chunk3 = "C".repeat(500);
    const deps = {
      mediaSender: {} as Parameters<typeof sendTextOnlyReply>[5]["mediaSender"],
      chunkText: (_text: string, _limit: number) => [chunk1, chunk2, chunk3],
    };

    await expect(
      sendTextOnlyReply(
        `${chunk1}\n\n${chunk2}\n\n${chunk3}`,
        event,
        actx,
        sendWithRetry,
        consumeQuoteRef,
        deps,
      ),
    ).resolves.toBeUndefined();

    // All three chunks sent separately — no merge, no errors.
    expect(sendTextMock).toHaveBeenCalledTimes(3);
    expect(sendTextMock.mock.calls[0]?.[1]).toBe(chunk1);
    expect(sendTextMock.mock.calls[1]?.[1]).toBe(chunk2);
    expect(sendTextMock.mock.calls[2]?.[1]).toBe(chunk3);
  });

  it("passes through a single chunk unchanged", async () => {
    const deps = {
      mediaSender: {} as Parameters<typeof sendTextOnlyReply>[5]["mediaSender"],
      chunkText: (_text: string, _limit: number) => ["Just one chunk."],
    };

    await sendTextOnlyReply("Just one chunk.", event, actx, sendWithRetry, consumeQuoteRef, deps);

    expect(sendTextMock).toHaveBeenCalledTimes(1);
    expect(sendTextMock.mock.calls[0]?.[1]).toBe("Just one chunk.");
  });

  it("retries with original chunks when merged send fails with a deterministic 4xx rejection", async () => {
    // chunkText returns two small chunks that would normally merge.
    // Make sendText fail with a deterministic QQ rejection (ApiError, 4xx).
    const chunk1 = "First paragraph.";
    const chunk2 = "Second paragraph.";
    sendTextMock
      .mockRejectedValueOnce(new ApiError("API Error", 400, "/v2/messages"))
      .mockResolvedValueOnce({ id: "fb-1", timestamp: "2026-07-01T00:00:00.000Z" })
      .mockResolvedValueOnce({ id: "fb-2", timestamp: "2026-07-01T00:00:00.000Z" });

    const deps = {
      mediaSender: {} as Parameters<typeof sendTextOnlyReply>[5]["mediaSender"],
      chunkText: (_text: string, _limit: number) => [chunk1, chunk2],
    };

    // Must not throw — fallback sends the original chunks individually.
    await expect(
      sendTextOnlyReply(
        `${chunk1}\n\n${chunk2}`,
        event,
        actx,
        sendWithRetry,
        consumeQuoteRef,
        deps,
      ),
    ).resolves.toBeUndefined();

    // 3 calls total: 1 failed merged send + 2 fallback original chunks.
    expect(sendTextMock).toHaveBeenCalledTimes(3);
    // First attempt: the merged chunk.
    expect(sendTextMock.mock.calls[0]?.[1]).toBe("First paragraph.\n\nSecond paragraph.");
    // Fallback: original chunks sent individually in order.
    expect(sendTextMock.mock.calls[1]?.[1]).toBe(chunk1);
    expect(sendTextMock.mock.calls[2]?.[1]).toBe(chunk2);
  });

  it("does NOT retry original chunks when merged send fails with a timeout (httpStatus 0)", async () => {
    // Timeout errors have httpStatus 0 — the merged POST may have been accepted.
    const chunk1 = "A";
    const chunk2 = "B";
    sendTextMock.mockRejectedValueOnce(new ApiError("Request timeout", 0, "/v2/messages"));

    const deps = {
      mediaSender: {} as Parameters<typeof sendTextOnlyReply>[5]["mediaSender"],
      chunkText: (_text: string, _limit: number) => [chunk1, chunk2],
    };

    await expect(
      sendTextOnlyReply(
        `${chunk1}\n\n${chunk2}`,
        event,
        actx,
        sendWithRetry,
        consumeQuoteRef,
        deps,
      ),
    ).resolves.toBeUndefined();

    // Only 1 call: the failed merged send. No fallback retries.
    expect(sendTextMock).toHaveBeenCalledTimes(1);
    expect(sendTextMock.mock.calls[0]?.[1]).toBe("A\n\nB");
  });

  it("does NOT retry original chunks when merged send fails with a 5xx server error", async () => {
    // 5xx errors are ambiguous — the server may have processed the request.
    const chunk1 = "A";
    const chunk2 = "B";
    sendTextMock.mockRejectedValueOnce(new ApiError("Server error", 502, "/v2/messages"));

    const deps = {
      mediaSender: {} as Parameters<typeof sendTextOnlyReply>[5]["mediaSender"],
      chunkText: (_text: string, _limit: number) => [chunk1, chunk2],
    };

    await expect(
      sendTextOnlyReply(
        `${chunk1}\n\n${chunk2}`,
        event,
        actx,
        sendWithRetry,
        consumeQuoteRef,
        deps,
      ),
    ).resolves.toBeUndefined();

    // Only 1 call: the failed merged send. No fallback retries.
    expect(sendTextMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry original chunks when merged send fails with a generic Error", async () => {
    // Generic errors are not ApiError instances — unknown delivery state.
    const chunk1 = "A";
    const chunk2 = "B";
    sendTextMock.mockRejectedValueOnce(new Error("Unexpected failure"));

    const deps = {
      mediaSender: {} as Parameters<typeof sendTextOnlyReply>[5]["mediaSender"],
      chunkText: (_text: string, _limit: number) => [chunk1, chunk2],
    };

    await expect(
      sendTextOnlyReply(
        `${chunk1}\n\n${chunk2}`,
        event,
        actx,
        sendWithRetry,
        consumeQuoteRef,
        deps,
      ),
    ).resolves.toBeUndefined();

    // Only 1 call: the failed merged send. No fallback retries.
    expect(sendTextMock).toHaveBeenCalledTimes(1);
  });
});
