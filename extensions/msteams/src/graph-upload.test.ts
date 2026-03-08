import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MSTeamsAccessTokenProvider } from "./attachments/types.js";
import { uploadToOneDrive, uploadToSharePoint } from "./graph-upload.js";

const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";

describe("graph-upload", () => {
  const mockTokenProvider: MSTeamsAccessTokenProvider = {
    getAccessToken: vi.fn().mockResolvedValue("mock-token"),
  };

  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("uploadToOneDrive", () => {
    it("should use simple upload for files <= 4MB", async () => {
      // 1MB buffer
      const buffer = Buffer.alloc(1 * 1024 * 1024);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "test-id",
          webUrl: "test-url",
          name: "test-name",
        }),
      });

      const result = await uploadToOneDrive({
        buffer,
        filename: "test.txt",
        tokenProvider: mockTokenProvider,
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      expect(result).toEqual({
        id: "test-id",
        webUrl: "test-url",
        name: "test-name",
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0][0]).toContain("/content");
      expect(mockFetch.mock.calls[0][1].method).toBe("PUT");
    });

    it("should use upload session for files > 4MB", async () => {
      // 5MB buffer
      const buffer = Buffer.alloc(5 * 1024 * 1024);

      // Mock createUploadSession response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          uploadUrl: "https://mock.upload/url",
        }),
      });

      // Mock chunk upload responses
      // 5MB will require 2 chunks of ~3.1MB
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          /* intermediate chunk response */
        }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "large-test-id",
          webUrl: "large-test-url",
          name: "large-test-name",
        }),
      });

      const result = await uploadToOneDrive({
        buffer,
        filename: "large.txt",
        tokenProvider: mockTokenProvider,
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      expect(result).toEqual({
        id: "large-test-id",
        webUrl: "large-test-url",
        name: "large-test-name",
      });

      expect(mockFetch).toHaveBeenCalledTimes(3);

      // Step 1: create session
      expect(mockFetch.mock.calls[0][0]).toContain("/createUploadSession");
      expect(mockFetch.mock.calls[0][1].method).toBe("POST");

      // Step 2: chunk 1
      expect(mockFetch.mock.calls[1][0]).toBe("https://mock.upload/url");
      expect(mockFetch.mock.calls[1][1].method).toBe("PUT");
      expect(mockFetch.mock.calls[1][1].headers["Content-Range"]).toMatch(/bytes 0-3276799\/\d+/);

      // Step 3: chunk 2
      expect(mockFetch.mock.calls[2][0]).toBe("https://mock.upload/url");
      expect(mockFetch.mock.calls[2][1].method).toBe("PUT");
      expect(mockFetch.mock.calls[2][1].headers["Content-Range"]).toMatch(/bytes 3276800-.*?\/\d+/);
    });
  });

  describe("uploadToSharePoint", () => {
    it("should use upload session for files > 4MB", async () => {
      const buffer = Buffer.alloc(5 * 1024 * 1024);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          uploadUrl: "https://sp.mock.upload/url",
        }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "sp-large-test-id",
          webUrl: "sp-large-test-url",
          name: "sp-large-test-name",
        }),
      });

      const result = await uploadToSharePoint({
        buffer,
        filename: "sp-large.txt",
        siteId: "test-site",
        tokenProvider: mockTokenProvider,
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      expect(result).toEqual({
        id: "sp-large-test-id",
        webUrl: "sp-large-test-url",
        name: "sp-large-test-name",
      });

      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(mockFetch.mock.calls[0][0]).toContain("/sites/test-site/drive/root");
      expect(mockFetch.mock.calls[0][0]).toContain("/createUploadSession");
    });
  });
});
