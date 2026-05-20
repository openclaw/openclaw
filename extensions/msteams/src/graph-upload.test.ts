import { describe, expect, it, vi } from "vitest";
import type { MSTeamsAccessTokenProvider } from "./attachments/types.js";
import { uploadToOneDrive, uploadToSharePoint } from "./graph-upload.js";

const TOKEN = "fake-bearer-token";

function makeTokenProvider(): MSTeamsAccessTokenProvider {
  return {
    getAccessToken: vi.fn(async () => TOKEN),
  } as unknown as MSTeamsAccessTokenProvider;
}

function jsonResponse(status: number, body: unknown, init: { statusText?: string } = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: init.statusText ?? "",
    headers: { "Content-Type": "application/json" },
  });
}

function emptyResponse(status: number, statusText = ""): Response {
  return new Response(null, { status, statusText });
}

describe("uploadToOneDrive — simple PUT path (<= 4 MiB)", () => {
  it("PUTs a 1 MiB buffer in a single request and returns the driveItem", async () => {
    const buffer = Buffer.alloc(1 * 1024 * 1024, 7);
    const fetchFn = vi.fn().mockResolvedValueOnce(
      jsonResponse(201, {
        id: "small-id",
        webUrl: "https://contoso/small",
        name: "small.bin",
      }),
    );

    const result = await uploadToOneDrive({
      buffer,
      filename: "small.bin",
      tokenProvider: makeTokenProvider(),
      fetchFn,
    });

    expect(result).toEqual({
      id: "small-id",
      webUrl: "https://contoso/small",
      name: "small.bin",
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(
      "https://graph.microsoft.com/v1.0/me/drive/root:/OpenClawShared/small.bin:/content",
    );
    expect(init.method).toBe("PUT");
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("throws a labeled error when the simple PUT returns non-2xx", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(
      new Response("nope", { status: 503, statusText: "Service Unavailable" }),
    );

    await expect(
      uploadToOneDrive({
        buffer: Buffer.alloc(1024),
        filename: "x.bin",
        tokenProvider: makeTokenProvider(),
        fetchFn,
      }),
    ).rejects.toThrow(/OneDrive upload failed: 503/);
  });

  it("throws when the simple PUT response is missing id/webUrl/name", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(jsonResponse(201, { id: "only-id" }));
    await expect(
      uploadToOneDrive({
        buffer: Buffer.alloc(1024),
        filename: "x.bin",
        tokenProvider: makeTokenProvider(),
        fetchFn,
      }),
    ).rejects.toThrow(/OneDrive response missing required fields/);
  });
});

describe("uploadToOneDrive — resumable upload session (> 4 MiB)", () => {
  it("creates an upload session and PUTs the file in three Content-Range chunks", async () => {
    // 5 MiB file with a 2 MiB chunk size → 3 chunks (2 + 2 + 1).
    const total = 5 * 1024 * 1024;
    const chunkSize = 2 * 1024 * 1024;
    const buffer = Buffer.alloc(total, 1);

    const uploadUrl = "https://contoso.sharepoint.com/uploadSession/abc-123";
    const finalItem = {
      id: "large-id",
      webUrl: "https://contoso/large",
      name: "big.bin",
    };

    const fetchFn = vi
      .fn()
      // createUploadSession
      .mockResolvedValueOnce(jsonResponse(200, { uploadUrl }))
      // chunk 1
      .mockResolvedValueOnce(jsonResponse(202, { nextExpectedRanges: [`${chunkSize}-`] }))
      // chunk 2
      .mockResolvedValueOnce(jsonResponse(202, { nextExpectedRanges: [`${chunkSize * 2}-`] }))
      // chunk 3 — final
      .mockResolvedValueOnce(jsonResponse(201, finalItem));

    const result = await uploadToOneDrive({
      buffer,
      filename: "big.bin",
      tokenProvider: makeTokenProvider(),
      fetchFn,
      chunkSize,
    });

    expect(result).toEqual(finalItem);
    expect(fetchFn).toHaveBeenCalledTimes(4);

    const [sessionUrl, sessionInit] = fetchFn.mock.calls[0];
    expect(sessionUrl).toBe(
      "https://graph.microsoft.com/v1.0/me/drive/root:/OpenClawShared/big.bin:/createUploadSession",
    );
    expect(sessionInit.method).toBe("POST");
    expect(sessionInit.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(sessionInit.body as string)).toEqual({
      item: { "@microsoft.graph.conflictBehavior": "rename", name: "big.bin" },
    });

    const ranges = fetchFn.mock.calls.slice(1).map((call) => {
      const init = call[1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      return {
        url: call[0],
        method: init.method,
        range: headers["Content-Range"],
        length: headers["Content-Length"],
      };
    });

    expect(ranges).toEqual([
      {
        url: uploadUrl,
        method: "PUT",
        range: `bytes 0-${chunkSize - 1}/${total}`,
        length: String(chunkSize),
      },
      {
        url: uploadUrl,
        method: "PUT",
        range: `bytes ${chunkSize}-${chunkSize * 2 - 1}/${total}`,
        length: String(chunkSize),
      },
      {
        url: uploadUrl,
        method: "PUT",
        range: `bytes ${chunkSize * 2}-${total - 1}/${total}`,
        length: String(total - chunkSize * 2),
      },
    ]);
  });

  it("cancels the session with DELETE when a chunk PUT fails", async () => {
    const total = 5 * 1024 * 1024;
    const chunkSize = 2 * 1024 * 1024;
    const buffer = Buffer.alloc(total, 2);
    const uploadUrl = "https://contoso.sharepoint.com/uploadSession/abandon";

    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { uploadUrl }))
      // chunk 1 fails
      .mockResolvedValueOnce(new Response("boom", { status: 500, statusText: "Server Error" }))
      // cancel
      .mockResolvedValueOnce(emptyResponse(204));

    await expect(
      uploadToOneDrive({
        buffer,
        filename: "doomed.bin",
        tokenProvider: makeTokenProvider(),
        fetchFn,
        chunkSize,
      }),
    ).rejects.toThrow(/OneDrive chunk upload failed at bytes 0-/);

    expect(fetchFn).toHaveBeenCalledTimes(3);
    const [cancelUrl, cancelInit] = fetchFn.mock.calls[2];
    expect(cancelUrl).toBe(uploadUrl);
    expect(cancelInit.method).toBe("DELETE");
  });

  it("propagates errors but still attempts session cancellation on fetch rejection", async () => {
    const total = 5 * 1024 * 1024;
    const chunkSize = 2 * 1024 * 1024;
    const buffer = Buffer.alloc(total, 3);
    const uploadUrl = "https://contoso.sharepoint.com/uploadSession/network-fail";

    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { uploadUrl }))
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(emptyResponse(204));

    await expect(
      uploadToOneDrive({
        buffer,
        filename: "doomed.bin",
        tokenProvider: makeTokenProvider(),
        fetchFn,
        chunkSize,
      }),
    ).rejects.toThrow(/ECONNRESET/);
    expect(fetchFn.mock.calls[2][1].method).toBe("DELETE");
  });

  it("throws a labeled error if createUploadSession returns non-2xx", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response("denied", { status: 403, statusText: "Forbidden" }));

    await expect(
      uploadToOneDrive({
        buffer: Buffer.alloc(5 * 1024 * 1024, 4),
        filename: "x.bin",
        tokenProvider: makeTokenProvider(),
        fetchFn,
        chunkSize: 2 * 1024 * 1024,
      }),
    ).rejects.toThrow(/OneDrive createUploadSession failed: 403/);
  });

  it("throws if createUploadSession response lacks uploadUrl", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(jsonResponse(200, {}));
    await expect(
      uploadToOneDrive({
        buffer: Buffer.alloc(5 * 1024 * 1024, 5),
        filename: "x.bin",
        tokenProvider: makeTokenProvider(),
        fetchFn,
        chunkSize: 2 * 1024 * 1024,
      }),
    ).rejects.toThrow(/createUploadSession response missing uploadUrl/);
  });
});

describe("uploadToSharePoint", () => {
  it("uses the simple :/content endpoint under the site for small buffers", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(201, { id: "sp-id", webUrl: "https://sp/small", name: "s.bin" }),
      );

    const result = await uploadToSharePoint({
      buffer: Buffer.alloc(1024, 6),
      filename: "s.bin",
      tokenProvider: makeTokenProvider(),
      fetchFn,
      siteId: "tenant.sharepoint.com,site,web",
    });

    expect(result).toEqual({ id: "sp-id", webUrl: "https://sp/small", name: "s.bin" });
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(
      "https://graph.microsoft.com/v1.0/sites/tenant.sharepoint.com,site,web/drive/root:/OpenClawShared/s.bin:/content",
    );
    expect(init.method).toBe("PUT");
  });

  it("upgrades to the upload-session protocol for large buffers under the site root", async () => {
    const total = 5 * 1024 * 1024;
    const chunkSize = 2 * 1024 * 1024;
    const buffer = Buffer.alloc(total, 9);
    const uploadUrl = "https://contoso.sharepoint.com/uploadSession/sp-large";

    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { uploadUrl }))
      .mockResolvedValueOnce(jsonResponse(202, {}))
      .mockResolvedValueOnce(jsonResponse(202, {}))
      .mockResolvedValueOnce(
        jsonResponse(201, { id: "sp-big", webUrl: "https://sp/big", name: "big.bin" }),
      );

    const result = await uploadToSharePoint({
      buffer,
      filename: "big.bin",
      tokenProvider: makeTokenProvider(),
      fetchFn,
      siteId: "tenant,site,web",
      chunkSize,
    });

    expect(result).toEqual({ id: "sp-big", webUrl: "https://sp/big", name: "big.bin" });
    expect(fetchFn.mock.calls[0][0]).toBe(
      "https://graph.microsoft.com/v1.0/sites/tenant,site,web/drive/root:/OpenClawShared/big.bin:/createUploadSession",
    );
    // Three PUT chunks against the issued upload URL.
    expect(fetchFn.mock.calls.slice(1).map((c) => c[0])).toEqual([
      uploadUrl,
      uploadUrl,
      uploadUrl,
    ]);
  });
});
