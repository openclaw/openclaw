import { describe, expect, it, vi } from "vitest";
import { withFetchPreconnect } from "../../../test/helpers/extensions/fetch-mock.js";
import { uploadToOneDrive, uploadToSharePoint } from "./graph-upload.js";

describe("graph upload helpers", () => {
  const tokenProvider = {
    getAccessToken: vi.fn(async () => "graph-token"),
  };

  it("uploads to OneDrive with the personal drive path", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ id: "item-1", webUrl: "https://example.com/1", name: "a.txt" }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );

    const result = await uploadToOneDrive({
      buffer: Buffer.from("hello"),
      filename: "a.txt",
      tokenProvider,
      fetchFn: withFetchPreconnect(fetchFn),
    });

    expect(fetchFn).toHaveBeenCalledWith(
      "https://graph.microsoft.com/v1.0/me/drive/root:/OpenClawShared/a.txt:/content",
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({
          Authorization: "Bearer graph-token",
          "Content-Type": "application/octet-stream",
        }),
      }),
    );
    expect(result).toEqual({
      id: "item-1",
      webUrl: "https://example.com/1",
      name: "a.txt",
    });
  });

  it("uploads to SharePoint with the site drive path", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ id: "item-2", webUrl: "https://example.com/2", name: "b.txt" }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );

    const result = await uploadToSharePoint({
      buffer: Buffer.from("world"),
      filename: "b.txt",
      siteId: "site-123",
      tokenProvider,
      fetchFn: withFetchPreconnect(fetchFn),
    });

    expect(fetchFn).toHaveBeenCalledWith(
      "https://graph.microsoft.com/v1.0/sites/site-123/drive/root:/OpenClawShared/b.txt:/content",
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({
          Authorization: "Bearer graph-token",
          "Content-Type": "application/octet-stream",
        }),
      }),
    );
    expect(result).toEqual({
      id: "item-2",
      webUrl: "https://example.com/2",
      name: "b.txt",
    });
  });

  it("rejects upload responses missing required fields", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: "item-3" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await expect(
      uploadToSharePoint({
        buffer: Buffer.from("world"),
        filename: "bad.txt",
        siteId: "site-123",
        tokenProvider,
        fetchFn: withFetchPreconnect(fetchFn),
      }),
    ).rejects.toThrow("SharePoint upload response missing required fields");
  });
});
