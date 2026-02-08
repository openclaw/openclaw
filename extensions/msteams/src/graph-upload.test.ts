import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MSTeamsAccessTokenProvider } from "./attachments/types.js";
import {
  createSharingLink,
  getChatMembers,
  getDriveItemProperties,
  uploadAndShareOneDrive,
  uploadToOneDrive,
  uploadToSharePoint,
} from "./graph-upload.js";

describe("graph-upload", () => {
  let tokenProvider: MSTeamsAccessTokenProvider;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tokenProvider = {
      getAccessToken: vi.fn(async () => "mock-token"),
    };
    fetchMock = vi.fn();
  });

  describe("uploadToOneDrive", () => {
    it("uses simple upload for files ≤4MB", async () => {
      const buffer = Buffer.alloc(3 * 1024 * 1024); // 3MB
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "item123",
          webUrl: "https://onedrive.com/item123",
          name: "test.txt",
        }),
      });

      const result = await uploadToOneDrive({
        buffer,
        filename: "test.txt",
        tokenProvider,
        fetchFn: fetchMock,
      });

      expect(result).toEqual({
        id: "item123",
        webUrl: "https://onedrive.com/item123",
        name: "test.txt",
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/me/drive/root:/OpenClawShared/test.txt:/content"),
        expect.objectContaining({
          method: "PUT",
          headers: expect.objectContaining({
            Authorization: "Bearer mock-token",
          }),
        }),
      );
    });

    it("uses resumable upload for files >4MB", async () => {
      const buffer = Buffer.alloc(5 * 1024 * 1024); // 5MB

      // Mock createUploadSession response
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          uploadUrl: "https://upload.url/session123",
        }),
      });

      // Mock chunk uploads (5 chunks of 1MB each)
      for (let i = 0; i < 5; i++) {
        const isLastChunk = i === 4;
        fetchMock.mockResolvedValueOnce({
          ok: true,
          json: async () =>
            isLastChunk
              ? {
                  id: "item123",
                  webUrl: "https://onedrive.com/item123",
                  name: "large.bin",
                }
              : { status: "uploading" },
        });
      }

      const result = await uploadToOneDrive({
        buffer,
        filename: "large.bin",
        tokenProvider,
        fetchFn: fetchMock,
      });

      expect(result).toEqual({
        id: "item123",
        webUrl: "https://onedrive.com/item123",
        name: "large.bin",
      });
      // 1 session creation + 5 chunk uploads
      expect(fetchMock).toHaveBeenCalledTimes(6);

      // Verify session creation
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining("/me/drive/root:/OpenClawShared/large.bin:/createUploadSession"),
        expect.objectContaining({ method: "POST" }),
      );

      // Verify chunk uploads with correct Content-Range headers
      for (let i = 0; i < 5; i++) {
        const start = i * 1024 * 1024;
        const end = Math.min(start + 1024 * 1024, 5 * 1024 * 1024);
        expect(fetchMock).toHaveBeenNthCalledWith(
          i + 2,
          "https://upload.url/session123",
          expect.objectContaining({
            method: "PUT",
            headers: expect.objectContaining({
              "Content-Range": `bytes ${start}-${end - 1}/${5 * 1024 * 1024}`,
            }),
          }),
        );
      }
    });

    it("retries failed chunks with exponential backoff", async () => {
      const buffer = Buffer.alloc(5 * 1024 * 1024); // 5MB

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ uploadUrl: "https://upload.url/session123" }),
      });

      // First chunk fails twice, succeeds on third attempt
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Server Error",
        text: async () => "error",
      });
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Server Error",
        text: async () => "error",
      });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: "uploading" }),
      });

      // Remaining chunks succeed
      for (let i = 1; i < 5; i++) {
        const isLastChunk = i === 4;
        fetchMock.mockResolvedValueOnce({
          ok: true,
          json: async () =>
            isLastChunk
              ? { id: "item123", webUrl: "https://onedrive.com/item123", name: "retry.bin" }
              : { status: "uploading" },
        });
      }

      const startTime = Date.now();
      const result = await uploadToOneDrive({
        buffer,
        filename: "retry.bin",
        tokenProvider,
        fetchFn: fetchMock,
      });
      const elapsed = Date.now() - startTime;

      expect(result.id).toBe("item123");
      // Should have waited at least 1s + 2s = 3s for retries
      expect(elapsed).toBeGreaterThanOrEqual(3000);
      // 1 session + 2 failed + 1 success + 4 more chunks = 8 calls
      expect(fetchMock).toHaveBeenCalledTimes(8);
    });

    it.skip("throws after MAX_RETRIES failed attempts (skipped: slow 7s+ test)", async () => {
      // This test validates the retry exhaustion logic but takes 7+ seconds
      // due to exponential backoff (1s + 2s + 4s). Skipped in routine runs.
      const buffer = Buffer.alloc(5 * 1024 * 1024); // 5MB

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ uploadUrl: "https://upload.url/session123" }),
      });

      // All 3 retry attempts fail
      for (let i = 0; i < 3; i++) {
        fetchMock.mockResolvedValueOnce({
          ok: false,
          status: 500,
          statusText: "Server Error",
          text: async () => "persistent error",
        });
      }

      await expect(
        uploadToOneDrive({
          buffer,
          filename: "fail.bin",
          tokenProvider,
          fetchFn: fetchMock,
        }),
      ).rejects.toThrow(/Chunk upload failed after 3 attempts/);
    });

    it("preserves original error in cause", async () => {
      const buffer = Buffer.alloc(5 * 1024 * 1024);

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ uploadUrl: "https://upload.url/session123" }),
      });

      const networkError = new Error("Network failure");
      fetchMock.mockRejectedValue(networkError);

      try {
        await uploadToOneDrive({
          buffer,
          filename: "error.bin",
          tokenProvider,
          fetchFn: fetchMock,
        });
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        const error = err as Error & { cause?: unknown };
        expect(error.message).toContain("Chunk upload failed after 3 attempts");
        expect(error.cause).toBe(networkError);
      }
    });

    it("handles missing required fields in response", async () => {
      const buffer = Buffer.alloc(1024);
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "item123" }), // missing webUrl and name
      });

      await expect(
        uploadToOneDrive({
          buffer,
          filename: "incomplete.txt",
          tokenProvider,
          fetchFn: fetchMock,
        }),
      ).rejects.toThrow(/missing required fields/);
    });
  });

  describe("uploadToSharePoint", () => {
    it("uses simple upload for files ≤4MB", async () => {
      const buffer = Buffer.alloc(2 * 1024 * 1024); // 2MB
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "sp-item123",
          webUrl: "https://sharepoint.com/item123",
          name: "doc.pdf",
        }),
      });

      const result = await uploadToSharePoint({
        buffer,
        filename: "doc.pdf",
        siteId: "site-123",
        tokenProvider,
        fetchFn: fetchMock,
      });

      expect(result).toEqual({
        id: "sp-item123",
        webUrl: "https://sharepoint.com/item123",
        name: "doc.pdf",
      });
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/sites/site-123/drive/root:/OpenClawShared/doc.pdf:/content"),
        expect.objectContaining({ method: "PUT" }),
      );
    });

    it("uses resumable upload for files >4MB", async () => {
      const buffer = Buffer.alloc(6 * 1024 * 1024); // 6MB

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ uploadUrl: "https://sp-upload.url/session" }),
      });

      // 6 chunks of 1MB each
      for (let i = 0; i < 6; i++) {
        const isLastChunk = i === 5;
        fetchMock.mockResolvedValueOnce({
          ok: true,
          json: async () =>
            isLastChunk
              ? { id: "sp-large", webUrl: "https://sharepoint.com/large", name: "large.zip" }
              : { status: "uploading" },
        });
      }

      const result = await uploadToSharePoint({
        buffer,
        filename: "large.zip",
        siteId: "site-456",
        tokenProvider,
        fetchFn: fetchMock,
      });

      expect(result.id).toBe("sp-large");
      expect(fetchMock).toHaveBeenCalledTimes(7); // 1 session + 6 chunks
    });
  });

  describe("createSharingLink", () => {
    it("creates organization sharing link by default", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          link: { webUrl: "https://share.link/org" },
        }),
      });

      const result = await createSharingLink({
        itemId: "item123",
        tokenProvider,
        fetchFn: fetchMock,
      });

      expect(result.webUrl).toBe("https://share.link/org");
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/me/drive/items/item123/createLink"),
        expect.objectContaining({
          body: expect.stringContaining('"scope":"organization"'),
        }),
      );
    });

    it("creates anonymous sharing link when specified", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          link: { webUrl: "https://share.link/anon" },
        }),
      });

      await createSharingLink({
        itemId: "item123",
        scope: "anonymous",
        tokenProvider,
        fetchFn: fetchMock,
      });

      expect(fetchMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          body: expect.stringContaining('"scope":"anonymous"'),
        }),
      );
    });
  });

  describe("uploadAndShareOneDrive", () => {
    it("uploads and creates sharing link in sequence", async () => {
      const buffer = Buffer.alloc(1024);

      // Upload response
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "uploaded-123",
          webUrl: "https://onedrive.com/uploaded-123",
          name: "shared.txt",
        }),
      });

      // Share link response
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          link: { webUrl: "https://share.link/shared" },
        }),
      });

      const result = await uploadAndShareOneDrive({
        buffer,
        filename: "shared.txt",
        tokenProvider,
        fetchFn: fetchMock,
      });

      expect(result).toEqual({
        itemId: "uploaded-123",
        webUrl: "https://onedrive.com/uploaded-123",
        shareUrl: "https://share.link/shared",
        name: "shared.txt",
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("getDriveItemProperties", () => {
    it("fetches eTag and webDavUrl for driveItem", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          eTag: '"etag-value"',
          webDavUrl: "https://sharepoint.com/webdav/file.txt",
          name: "file.txt",
        }),
      });

      const result = await getDriveItemProperties({
        siteId: "site-789",
        itemId: "item-abc",
        tokenProvider,
        fetchFn: fetchMock,
      });

      expect(result).toEqual({
        eTag: '"etag-value"',
        webDavUrl: "https://sharepoint.com/webdav/file.txt",
        name: "file.txt",
      });
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/sites/site-789/drive/items/item-abc"),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer mock-token",
          }),
        }),
      );
    });
  });

  describe("getChatMembers", () => {
    it("fetches chat members", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [
            {
              userId: "user-1",
              displayName: "Alice",
            },
            {
              userId: "user-2",
              displayName: "Bob",
            },
          ],
        }),
      });

      const result = await getChatMembers({
        chatId: "chat-123",
        tokenProvider,
        fetchFn: fetchMock,
      });

      expect(result).toEqual([
        { aadObjectId: "user-1", displayName: "Alice" },
        { aadObjectId: "user-2", displayName: "Bob" },
      ]);
      expect(result).toHaveLength(2);
    });
  });

  describe("edge cases", () => {
    it("handles files exactly at 4MB boundary", async () => {
      const buffer = Buffer.alloc(4 * 1024 * 1024); // exactly 4MB

      // Should use simple upload (≤4MB)
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "boundary",
          webUrl: "https://onedrive.com/boundary",
          name: "4mb.bin",
        }),
      });

      await uploadToOneDrive({
        buffer,
        filename: "4mb.bin",
        tokenProvider,
        fetchFn: fetchMock,
      });

      // Verify simple upload was used (only 1 call)
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining(":/content"),
        expect.objectContaining({ method: "PUT" }),
      );
    });

    it("handles files just over 4MB boundary", async () => {
      const buffer = Buffer.alloc(4 * 1024 * 1024 + 1); // 4MB + 1 byte

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ uploadUrl: "https://upload.url/session" }),
      });

      // 5 chunks (4 full 1MB + 1 tiny chunk)
      for (let i = 0; i < 5; i++) {
        const isLastChunk = i === 4;
        fetchMock.mockResolvedValueOnce({
          ok: true,
          json: async () =>
            isLastChunk
              ? { id: "over", webUrl: "https://onedrive.com/over", name: "over.bin" }
              : { status: "uploading" },
        });
      }

      await uploadToOneDrive({
        buffer,
        filename: "over.bin",
        tokenProvider,
        fetchFn: fetchMock,
      });

      expect(fetchMock).toHaveBeenCalledTimes(6); // resumable upload
    });

    it("handles non-Error exceptions in retry logic", async () => {
      const buffer = Buffer.alloc(5 * 1024 * 1024);

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ uploadUrl: "https://upload.url/session" }),
      });

      // Throw non-Error object
      fetchMock.mockRejectedValue("string error");

      try {
        await uploadToOneDrive({
          buffer,
          filename: "string-error.bin",
          tokenProvider,
          fetchFn: fetchMock,
        });
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        const error = err as Error & { cause?: unknown };
        expect(error.message).toContain("Chunk upload failed after 3 attempts");
        expect(error.cause).toBe("string error");
      }
    });
  });
});
