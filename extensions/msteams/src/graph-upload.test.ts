import { afterEach, describe, expect, it, vi } from "vitest";
import { uploadToOneDrive, uploadToSharePoint } from "./graph-upload.js";

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

  it("uses server nextExpectedRanges when resuming upload session for files > 4MB", async () => {
    const totalBytes = 5 * 1024 * 1024 + 20;
    const resumedStart = 3 * 1024 * 1024;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/createUploadSession")) {
        return new Response(JSON.stringify({ uploadUrl: "https://upload.example/session" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url === "https://upload.example/session") {
        const contentRange =
          (init?.headers as Record<string, string> | undefined)?.["Content-Range"] ?? "";
        if (contentRange.startsWith("bytes 0-")) {
          return new Response(JSON.stringify({ nextExpectedRanges: [`${resumedStart}-`] }), {
            status: 202,
            headers: { "content-type": "application/json" },
          });
        }
        if (contentRange !== `bytes ${resumedStart}-5242899/${totalBytes}`) {
          return new Response("wrong continuation range", { status: 416 });
        }
        return new Response(
          JSON.stringify({
            id: "item-large",
            webUrl: "https://graph.example/items/item-large",
            name: "large.bin",
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }

      return new Response("unexpected", { status: 500 });
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
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const firstChunkHeaders = fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>;
    const secondChunkHeaders = fetchMock.mock.calls[2]?.[1]?.headers as Record<string, string>;

    expect(firstChunkHeaders["Content-Range"]).toBe(`bytes 0-5242879/${totalBytes}`);
    expect(secondChunkHeaders["Content-Range"]).toBe(`bytes ${resumedStart}-5242899/${totalBytes}`);
  });
});
