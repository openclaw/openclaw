import { describe, expect, it, vi } from "vitest";
import type { MSTeamsAccessTokenProvider } from "./attachments/types.js";
import { uploadToOneDrive, uploadToSharePoint } from "./graph-upload.js";

const FOUR_MB = 4 * 1024 * 1024;
const FIVE_MB = 5 * 1024 * 1024;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createTokenProvider() {
  const getAccessToken = vi.fn().mockResolvedValue("graph-token");
  const tokenProvider: MSTeamsAccessTokenProvider = { getAccessToken };
  return {
    tokenProvider,
    getAccessToken,
  };
}

describe("graph-upload", () => {
  it("uses simple OneDrive upload for files up to 4MB", async () => {
    const { tokenProvider, getAccessToken } = createTokenProvider();
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: "item-1",
        webUrl: "https://example.com/small",
        name: "small.txt",
      }),
    );

    const result = await uploadToOneDrive({
      buffer: Buffer.alloc(FOUR_MB),
      filename: "small.txt",
      tokenProvider,
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    expect(result).toEqual({
      id: "item-1",
      webUrl: "https://example.com/small",
      name: "small.txt",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getAccessToken).toHaveBeenCalledWith("https://graph.microsoft.com");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://graph.microsoft.com/v1.0/me/drive/root:/OpenClawShared/small.txt:/content",
    );
    expect(init.method).toBe("PUT");
  });

  it("uses upload sessions for large OneDrive files", async () => {
    const { tokenProvider } = createTokenProvider();
    const largeBuffer = Buffer.alloc(FIVE_MB + 10, 1);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ uploadUrl: "https://upload.example/session" }))
      .mockResolvedValueOnce(jsonResponse({ nextExpectedRanges: [`${FIVE_MB}-`] }, 202))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            id: "item-2",
            webUrl: "https://example.com/large",
            name: "large.bin",
          },
          201,
        ),
      );

    const result = await uploadToOneDrive({
      buffer: largeBuffer,
      filename: "large.bin",
      tokenProvider,
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    expect(result).toEqual({
      id: "item-2",
      webUrl: "https://example.com/large",
      name: "large.bin",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const [sessionUrl, sessionInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(sessionUrl).toBe(
      "https://graph.microsoft.com/v1.0/me/drive/root:/OpenClawShared/large.bin:/createUploadSession",
    );
    expect(sessionInit.method).toBe("POST");

    const [firstChunkUrl, firstChunkInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const firstChunkHeaders = firstChunkInit.headers as Record<string, string>;
    expect(firstChunkUrl).toBe("https://upload.example/session");
    expect(firstChunkHeaders["Content-Range"]).toBe(`bytes 0-${FIVE_MB - 1}/${largeBuffer.length}`);
    expect(firstChunkHeaders["Content-Length"]).toBe(String(FIVE_MB));

    const [secondChunkUrl, secondChunkInit] = fetchMock.mock.calls[2] as [string, RequestInit];
    const secondChunkHeaders = secondChunkInit.headers as Record<string, string>;
    expect(secondChunkUrl).toBe("https://upload.example/session");
    expect(secondChunkHeaders["Content-Range"]).toBe(
      `bytes ${FIVE_MB}-${largeBuffer.length - 1}/${largeBuffer.length}`,
    );
    expect(secondChunkHeaders["Content-Length"]).toBe("10");
  });

  it("retries the same chunk when nextExpectedRanges points to byte 0", async () => {
    const { tokenProvider } = createTokenProvider();
    const largeBuffer = Buffer.alloc(FIVE_MB + 10, 1);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ uploadUrl: "https://upload.example/session" }))
      .mockResolvedValueOnce(jsonResponse({ nextExpectedRanges: ["0-"] }, 202))
      .mockResolvedValueOnce(jsonResponse({ nextExpectedRanges: [`${FIVE_MB}-`] }, 202))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            id: "item-retry",
            webUrl: "https://example.com/retry",
            name: "retry.bin",
          },
          201,
        ),
      );

    const result = await uploadToOneDrive({
      buffer: largeBuffer,
      filename: "retry.bin",
      tokenProvider,
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    expect(result).toEqual({
      id: "item-retry",
      webUrl: "https://example.com/retry",
      name: "retry.bin",
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);

    const [, firstChunkInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const firstChunkHeaders = firstChunkInit.headers as Record<string, string>;
    expect(firstChunkHeaders["Content-Range"]).toBe(`bytes 0-${FIVE_MB - 1}/${largeBuffer.length}`);

    const [, retryChunkInit] = fetchMock.mock.calls[2] as [string, RequestInit];
    const retryChunkHeaders = retryChunkInit.headers as Record<string, string>;
    expect(retryChunkHeaders["Content-Range"]).toBe(`bytes 0-${FIVE_MB - 1}/${largeBuffer.length}`);
  });

  it("throws when upload session stalls on the same range", async () => {
    const { tokenProvider } = createTokenProvider();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ uploadUrl: "https://upload.example/session" }))
      .mockResolvedValueOnce(jsonResponse({ nextExpectedRanges: ["0-"] }, 202))
      .mockResolvedValueOnce(jsonResponse({ nextExpectedRanges: ["0-"] }, 202))
      .mockResolvedValueOnce(jsonResponse({ nextExpectedRanges: ["0-"] }, 202))
      .mockResolvedValueOnce(jsonResponse({ nextExpectedRanges: ["0-"] }, 202))
      .mockResolvedValueOnce(jsonResponse({ nextExpectedRanges: ["0-"] }, 202))
      .mockResolvedValueOnce(jsonResponse({ nextExpectedRanges: ["0-"] }, 202));

    await expect(
      uploadToOneDrive({
        buffer: Buffer.alloc(FIVE_MB + 1),
        filename: "stalled.bin",
        tokenProvider,
        fetchFn: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toThrow("OneDrive upload session stalled at byte 0");
  });

  it("throws when OneDrive upload session creation fails", async () => {
    const { tokenProvider } = createTokenProvider();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response("session failed", { status: 500, statusText: "Internal Server Error" }),
      );

    await expect(
      uploadToOneDrive({
        buffer: Buffer.alloc(FIVE_MB + 1),
        filename: "large.bin",
        tokenProvider,
        fetchFn: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toThrow("OneDrive upload session creation failed: 500 Internal Server Error");
  });

  it("uses upload sessions for large SharePoint files", async () => {
    const { tokenProvider } = createTokenProvider();
    const largeBuffer = Buffer.alloc(FIVE_MB + 1, 1);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ uploadUrl: "https://upload.example/sharepoint" }))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            id: "sp-item",
            webUrl: "https://example.com/sharepoint",
            name: "report.pdf",
          },
          201,
        ),
      );

    const result = await uploadToSharePoint({
      buffer: largeBuffer,
      filename: "report.pdf",
      siteId: "site-123",
      tokenProvider,
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    expect(result).toEqual({
      id: "sp-item",
      webUrl: "https://example.com/sharepoint",
      name: "report.pdf",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [sessionUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(sessionUrl).toBe(
      "https://graph.microsoft.com/v1.0/sites/site-123/drive/root:/OpenClawShared/report.pdf:/createUploadSession",
    );
  });
});
