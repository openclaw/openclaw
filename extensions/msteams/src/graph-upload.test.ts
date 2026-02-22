import { afterEach, describe, expect, it, vi } from "vitest";
import { createSharingLink, uploadToOneDrive, uploadToSharePoint } from "./graph-upload.js";

const tokenProvider = {
  getAccessToken: vi.fn(async () => "test-token"),
};

afterEach(() => {
  vi.restoreAllMocks();
  tokenProvider.getAccessToken.mockClear();
});

describe("graph-upload", () => {
  it("uses simple upload endpoint for files <= 4MB", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      return new Response(
        JSON.stringify({
          id: "item-1",
          webUrl: "https://graph.example/items/item-1",
          name: "report.txt",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await uploadToOneDrive({
      buffer: Buffer.from("hello"),
      filename: "report.txt",
      tokenProvider,
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    expect(result).toEqual({
      id: "item-1",
      webUrl: "https://graph.example/items/item-1",
      name: "report.txt",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toContain(
      "/me/drive/root:/OpenClawShared/report.txt:/content",
    );
  });

  it("uses simple upload endpoint for SharePoint uploads", async () => {
    const totalBytes = 5 * 1024 * 1024 + 20;
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      return new Response(
        JSON.stringify({
          id: "item-large",
          webUrl: "https://graph.example/items/item-large",
          name: "large.bin",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    });

    const result = await uploadToSharePoint({
      buffer: Buffer.alloc(totalBytes, 1),
      filename: "large.bin",
      siteId: "site-1",
      tokenProvider,
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    expect(result).toEqual({
      id: "item-large",
      webUrl: "https://graph.example/items/item-large",
      name: "large.bin",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toContain(
      "/sites/site-1/drive/root:/OpenClawShared/large.bin:/content",
    );
  });

  it("retries on 429 for Graph requests", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const retryResponse = new Response("rate limited", {
      status: 429,
      statusText: "Too Many Requests",
      headers: { "Retry-After": "0" },
    });
    const cancelSpy = vi.spyOn(retryResponse.body as ReadableStream, "cancel");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(retryResponse)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ link: { webUrl: "https://share.example/link" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const result = await createSharingLink({
      itemId: "item-123",
      tokenProvider,
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    expect(result.webUrl).toBe("https://share.example/link");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
