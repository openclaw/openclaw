import { describe, expect, it, vi } from "vitest";
import { uploadToOneDrive, uploadToSharePoint } from "./graph-upload.js";

describe("uploadToOneDrive", () => {
  it("throws a clear error for files larger than 4MB before making network calls", async () => {
    const getAccessToken = vi.fn(async () => "token");
    const fetchFn = vi.fn<typeof fetch>();
    const oversizedBuffer = Buffer.alloc(4 * 1024 * 1024 + 1, 1);

    await expect(
      uploadToOneDrive({
        buffer: oversizedBuffer,
        filename: "large.bin",
        tokenProvider: { getAccessToken },
        fetchFn,
      }),
    ).rejects.toThrow(/size limit exceeded/i);

    expect(getAccessToken).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("accepts files up to 4MB and uploads successfully", async () => {
    const getAccessToken = vi.fn(async () => "token");
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "item-1",
          webUrl: "https://example.com/item-1",
          name: "small.bin",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await uploadToOneDrive({
      buffer: Buffer.alloc(4 * 1024 * 1024, 1),
      filename: "small.bin",
      tokenProvider: { getAccessToken },
      fetchFn,
    });

    expect(result).toEqual({
      id: "item-1",
      webUrl: "https://example.com/item-1",
      name: "small.bin",
    });
    expect(getAccessToken).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe("uploadToSharePoint", () => {
  it("throws a clear error for files larger than 4MB before making network calls", async () => {
    const getAccessToken = vi.fn(async () => "token");
    const fetchFn = vi.fn<typeof fetch>();
    const oversizedBuffer = Buffer.alloc(4 * 1024 * 1024 + 1, 1);

    await expect(
      uploadToSharePoint({
        buffer: oversizedBuffer,
        filename: "large.bin",
        siteId: "contoso.sharepoint.com,guid1,guid2",
        tokenProvider: { getAccessToken },
        fetchFn,
      }),
    ).rejects.toThrow(/size limit exceeded/i);

    expect(getAccessToken).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("accepts files up to 4MB and uploads successfully", async () => {
    const getAccessToken = vi.fn(async () => "token");
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "item-1",
          webUrl: "https://example.com/item-1",
          name: "small.bin",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await uploadToSharePoint({
      buffer: Buffer.alloc(4 * 1024 * 1024, 1),
      filename: "small.bin",
      siteId: "contoso.sharepoint.com,guid1,guid2",
      tokenProvider: { getAccessToken },
      fetchFn,
    });

    expect(result).toEqual({
      id: "item-1",
      webUrl: "https://example.com/item-1",
      name: "small.bin",
    });
    expect(getAccessToken).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
