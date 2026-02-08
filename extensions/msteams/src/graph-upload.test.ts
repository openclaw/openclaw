import { describe, expect, it, vi } from "vitest";
import type { MSTeamsAccessTokenProvider } from "./attachments/types.js";
import {
  createSharePointSharingLink,
  createSharingLink,
  getChatMembers,
  getDriveItemProperties,
  uploadAndShareOneDrive,
  uploadAndShareSharePoint,
  uploadToOneDrive,
  uploadToSharePoint,
} from "./graph-upload.js";

/** Create a mock token provider for testing */
function createMockTokenProvider(): MSTeamsAccessTokenProvider {
  return {
    getAccessToken: vi.fn().mockResolvedValue("mock-token"),
  };
}

/** Create a mock fetch function for testing */
function createMockFetch(response: {
  ok: boolean;
  status?: number;
  statusText?: string;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
}): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 500),
    statusText: response.statusText ?? (response.ok ? "OK" : "Internal Server Error"),
    json: response.json ?? (async () => ({})),
    text: response.text ?? (async () => ""),
  }) as unknown as typeof fetch;
}

describe("graph-upload", () => {
  describe("uploadToOneDrive", () => {
    it("uploads a file successfully", async () => {
      const tokenProvider = createMockTokenProvider();
      const mockFetch = createMockFetch({
        ok: true,
        json: async () => ({
          id: "item-123",
          webUrl: "https://onedrive.example.com/file",
          name: "test.png",
        }),
      });

      const result = await uploadToOneDrive({
        buffer: Buffer.from("test-content"),
        filename: "test.png",
        contentType: "image/png",
        tokenProvider,
        fetchFn: mockFetch,
      });

      expect(result).toEqual({
        id: "item-123",
        webUrl: "https://onedrive.example.com/file",
        name: "test.png",
      });
      expect(tokenProvider.getAccessToken).toHaveBeenCalledWith("https://graph.microsoft.com");
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/me/drive/root:/OpenClawShared/test.png:/content"),
        expect.objectContaining({
          method: "PUT",
          headers: expect.objectContaining({
            Authorization: "Bearer mock-token",
            "Content-Type": "image/png",
          }),
        }),
      );
    });

    it("uses default content type when not specified", async () => {
      const tokenProvider = createMockTokenProvider();
      const mockFetch = createMockFetch({
        ok: true,
        json: async () => ({
          id: "item-123",
          webUrl: "https://onedrive.example.com/file",
          name: "data.bin",
        }),
      });

      await uploadToOneDrive({
        buffer: Buffer.from("binary-data"),
        filename: "data.bin",
        tokenProvider,
        fetchFn: mockFetch,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            "Content-Type": "application/octet-stream",
          }),
        }),
      );
    });

    it("encodes special characters in filename", async () => {
      const tokenProvider = createMockTokenProvider();
      const mockFetch = createMockFetch({
        ok: true,
        json: async () => ({
          id: "item-123",
          webUrl: "https://onedrive.example.com/file",
          name: "test file.png",
        }),
      });

      await uploadToOneDrive({
        buffer: Buffer.from("test"),
        filename: "test file.png",
        tokenProvider,
        fetchFn: mockFetch,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("test%20file.png"),
        expect.any(Object),
      );
    });

    it("throws on upload failure", async () => {
      const tokenProvider = createMockTokenProvider();
      const mockFetch = createMockFetch({
        ok: false,
        status: 403,
        statusText: "Forbidden",
        text: async () => "Access denied",
      });

      await expect(
        uploadToOneDrive({
          buffer: Buffer.from("test"),
          filename: "test.png",
          tokenProvider,
          fetchFn: mockFetch,
        }),
      ).rejects.toThrow("OneDrive upload failed: 403 Forbidden - Access denied");
    });

    it("throws when response missing required fields", async () => {
      const tokenProvider = createMockTokenProvider();
      const mockFetch = createMockFetch({
        ok: true,
        json: async () => ({ id: "item-123" }), // missing webUrl and name
      });

      await expect(
        uploadToOneDrive({
          buffer: Buffer.from("test"),
          filename: "test.png",
          tokenProvider,
          fetchFn: mockFetch,
        }),
      ).rejects.toThrow("OneDrive upload response missing required fields");
    });
  });

  describe("createSharingLink", () => {
    it("creates an organization-scoped sharing link by default", async () => {
      const tokenProvider = createMockTokenProvider();
      const mockFetch = createMockFetch({
        ok: true,
        json: async () => ({
          link: { webUrl: "https://share.example.com/link" },
        }),
      });

      const result = await createSharingLink({
        itemId: "item-123",
        tokenProvider,
        fetchFn: mockFetch,
      });

      expect(result).toEqual({ webUrl: "https://share.example.com/link" });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/me/drive/items/item-123/createLink"),
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining('"scope":"organization"'),
        }),
      );
    });

    it("creates an anonymous sharing link when specified", async () => {
      const tokenProvider = createMockTokenProvider();
      const mockFetch = createMockFetch({
        ok: true,
        json: async () => ({
          link: { webUrl: "https://share.example.com/anon-link" },
        }),
      });

      await createSharingLink({
        itemId: "item-123",
        tokenProvider,
        scope: "anonymous",
        fetchFn: mockFetch,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('"scope":"anonymous"'),
        }),
      );
    });

    it("throws on failure", async () => {
      const tokenProvider = createMockTokenProvider();
      const mockFetch = createMockFetch({
        ok: false,
        status: 404,
        statusText: "Not Found",
        text: async () => "Item not found",
      });

      await expect(
        createSharingLink({
          itemId: "item-123",
          tokenProvider,
          fetchFn: mockFetch,
        }),
      ).rejects.toThrow("Create sharing link failed: 404 Not Found - Item not found");
    });

    it("throws when response missing webUrl", async () => {
      const tokenProvider = createMockTokenProvider();
      const mockFetch = createMockFetch({
        ok: true,
        json: async () => ({ link: {} }),
      });

      await expect(
        createSharingLink({
          itemId: "item-123",
          tokenProvider,
          fetchFn: mockFetch,
        }),
      ).rejects.toThrow("Create sharing link response missing webUrl");
    });
  });

  describe("uploadAndShareOneDrive", () => {
    it("uploads and creates sharing link in one call", async () => {
      const tokenProvider = createMockTokenProvider();
      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // Upload call
          return {
            ok: true,
            json: async () => ({
              id: "item-456",
              webUrl: "https://onedrive.example.com/uploaded",
              name: "doc.pdf",
            }),
          };
        }
        // Sharing link call
        return {
          ok: true,
          json: async () => ({
            link: { webUrl: "https://share.example.com/shared-link" },
          }),
        };
      }) as unknown as typeof fetch;

      const result = await uploadAndShareOneDrive({
        buffer: Buffer.from("pdf-content"),
        filename: "doc.pdf",
        contentType: "application/pdf",
        tokenProvider,
        fetchFn: mockFetch,
      });

      expect(result).toEqual({
        itemId: "item-456",
        webUrl: "https://onedrive.example.com/uploaded",
        shareUrl: "https://share.example.com/shared-link",
        name: "doc.pdf",
      });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("uploadToSharePoint", () => {
    it("uploads a file to SharePoint site", async () => {
      const tokenProvider = createMockTokenProvider();
      const mockFetch = createMockFetch({
        ok: true,
        json: async () => ({
          id: "sp-item-123",
          webUrl: "https://sharepoint.example.com/file",
          name: "report.xlsx",
        }),
      });

      const result = await uploadToSharePoint({
        buffer: Buffer.from("spreadsheet-data"),
        filename: "report.xlsx",
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        tokenProvider,
        siteId: "contoso.sharepoint.com,guid1,guid2",
        fetchFn: mockFetch,
      });

      expect(result).toEqual({
        id: "sp-item-123",
        webUrl: "https://sharepoint.example.com/file",
        name: "report.xlsx",
      });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/sites/contoso.sharepoint.com,guid1,guid2/drive/root:"),
        expect.any(Object),
      );
    });

    it("throws on SharePoint upload failure", async () => {
      const tokenProvider = createMockTokenProvider();
      const mockFetch = createMockFetch({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        text: async () => "SharePoint is unavailable",
      });

      await expect(
        uploadToSharePoint({
          buffer: Buffer.from("test"),
          filename: "test.txt",
          tokenProvider,
          siteId: "site-123",
          fetchFn: mockFetch,
        }),
      ).rejects.toThrow(
        "SharePoint upload failed: 500 Internal Server Error - SharePoint is unavailable",
      );
    });
  });

  describe("getDriveItemProperties", () => {
    it("fetches driveItem properties for file card attachments", async () => {
      const tokenProvider = createMockTokenProvider();
      const mockFetch = createMockFetch({
        ok: true,
        json: async () => ({
          eTag: '"abc123"',
          webDavUrl: "https://sharepoint.example.com/webdav/file.pdf",
          name: "file.pdf",
        }),
      });

      const result = await getDriveItemProperties({
        siteId: "site-id",
        itemId: "item-id",
        tokenProvider,
        fetchFn: mockFetch,
      });

      expect(result).toEqual({
        eTag: '"abc123"',
        webDavUrl: "https://sharepoint.example.com/webdav/file.pdf",
        name: "file.pdf",
      });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/sites/site-id/drive/items/item-id?$select=eTag,webDavUrl,name"),
        expect.any(Object),
      );
    });

    it("throws when properties are missing", async () => {
      const tokenProvider = createMockTokenProvider();
      const mockFetch = createMockFetch({
        ok: true,
        json: async () => ({ eTag: '"abc"' }), // missing webDavUrl and name
      });

      await expect(
        getDriveItemProperties({
          siteId: "site-id",
          itemId: "item-id",
          tokenProvider,
          fetchFn: mockFetch,
        }),
      ).rejects.toThrow(
        "DriveItem response missing required properties (eTag, webDavUrl, or name)",
      );
    });
  });

  describe("getChatMembers", () => {
    it("fetches chat members", async () => {
      const tokenProvider = createMockTokenProvider();
      const mockFetch = createMockFetch({
        ok: true,
        json: async () => ({
          value: [
            { userId: "user-1", displayName: "Alice" },
            { userId: "user-2", displayName: "Bob" },
            { displayName: "No UserId" }, // should be filtered out
          ],
        }),
      });

      const result = await getChatMembers({
        chatId: "chat-123",
        tokenProvider,
        fetchFn: mockFetch,
      });

      expect(result).toEqual([
        { aadObjectId: "user-1", displayName: "Alice" },
        { aadObjectId: "user-2", displayName: "Bob" },
      ]);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/chats/chat-123/members"),
        expect.any(Object),
      );
    });

    it("returns empty array when no members", async () => {
      const tokenProvider = createMockTokenProvider();
      const mockFetch = createMockFetch({
        ok: true,
        json: async () => ({}),
      });

      const result = await getChatMembers({
        chatId: "chat-123",
        tokenProvider,
        fetchFn: mockFetch,
      });

      expect(result).toEqual([]);
    });

    it("throws on failure", async () => {
      const tokenProvider = createMockTokenProvider();
      const mockFetch = createMockFetch({
        ok: false,
        status: 403,
        statusText: "Forbidden",
        text: async () => "Missing Chat.Read.All permission",
      });

      await expect(
        getChatMembers({
          chatId: "chat-123",
          tokenProvider,
          fetchFn: mockFetch,
        }),
      ).rejects.toThrow(
        "Get chat members failed: 403 Forbidden - Missing Chat.Read.All permission",
      );
    });
  });

  describe("createSharePointSharingLink", () => {
    it("creates organization-scoped link using v1.0 API by default", async () => {
      const tokenProvider = createMockTokenProvider();
      const mockFetch = createMockFetch({
        ok: true,
        json: async () => ({
          link: { webUrl: "https://sharepoint.example.com/share-org" },
        }),
      });

      const result = await createSharePointSharingLink({
        siteId: "site-id",
        itemId: "item-id",
        tokenProvider,
        fetchFn: mockFetch,
      });

      expect(result).toEqual({ webUrl: "https://sharepoint.example.com/share-org" });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("graph.microsoft.com/v1.0/sites/"),
        expect.objectContaining({
          body: expect.stringContaining('"scope":"organization"'),
        }),
      );
    });

    it("creates per-user link using beta API with recipients", async () => {
      const tokenProvider = createMockTokenProvider();
      const mockFetch = createMockFetch({
        ok: true,
        json: async () => ({
          link: { webUrl: "https://sharepoint.example.com/share-users" },
        }),
      });

      await createSharePointSharingLink({
        siteId: "site-id",
        itemId: "item-id",
        tokenProvider,
        scope: "users",
        recipientObjectIds: ["user-1", "user-2"],
        fetchFn: mockFetch,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("graph.microsoft.com/beta/sites/"),
        expect.objectContaining({
          body: expect.stringMatching(
            /"recipients":\[.*"objectId":"user-1".*"objectId":"user-2".*\]/,
          ),
        }),
      );
    });

    it("throws on failure", async () => {
      const tokenProvider = createMockTokenProvider();
      const mockFetch = createMockFetch({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        text: async () => "Invalid site ID",
      });

      await expect(
        createSharePointSharingLink({
          siteId: "invalid-site",
          itemId: "item-id",
          tokenProvider,
          fetchFn: mockFetch,
        }),
      ).rejects.toThrow("Create SharePoint sharing link failed: 400 Bad Request - Invalid site ID");
    });
  });

  describe("uploadAndShareSharePoint", () => {
    it("uploads and shares with organization scope by default", async () => {
      const tokenProvider = createMockTokenProvider();
      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            ok: true,
            json: async () => ({
              id: "sp-item-789",
              webUrl: "https://sharepoint.example.com/file",
              name: "presentation.pptx",
            }),
          };
        }
        return {
          ok: true,
          json: async () => ({
            link: { webUrl: "https://sharepoint.example.com/org-link" },
          }),
        };
      }) as unknown as typeof fetch;

      const result = await uploadAndShareSharePoint({
        buffer: Buffer.from("pptx-data"),
        filename: "presentation.pptx",
        tokenProvider,
        siteId: "site-123",
        fetchFn: mockFetch,
      });

      expect(result).toEqual({
        itemId: "sp-item-789",
        webUrl: "https://sharepoint.example.com/file",
        shareUrl: "https://sharepoint.example.com/org-link",
        name: "presentation.pptx",
      });
    });

    it("uses per-user sharing when enabled with chatId", async () => {
      const tokenProvider = createMockTokenProvider();
      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // Upload
          return {
            ok: true,
            json: async () => ({
              id: "sp-item-789",
              webUrl: "https://sharepoint.example.com/file",
              name: "doc.pdf",
            }),
          };
        }
        if (callCount === 2) {
          // Get chat members
          return {
            ok: true,
            json: async () => ({
              value: [{ userId: "member-1" }, { userId: "member-2" }],
            }),
          };
        }
        // Create sharing link
        return {
          ok: true,
          json: async () => ({
            link: { webUrl: "https://sharepoint.example.com/user-link" },
          }),
        };
      }) as unknown as typeof fetch;

      const result = await uploadAndShareSharePoint({
        buffer: Buffer.from("pdf-data"),
        filename: "doc.pdf",
        tokenProvider,
        siteId: "site-123",
        chatId: "chat-456",
        usePerUserSharing: true,
        fetchFn: mockFetch,
      });

      expect(result.shareUrl).toBe("https://sharepoint.example.com/user-link");
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("falls back to organization scope when getChatMembers fails", async () => {
      const tokenProvider = createMockTokenProvider();
      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // Upload
          return {
            ok: true,
            json: async () => ({
              id: "sp-item-789",
              webUrl: "https://sharepoint.example.com/file",
              name: "doc.pdf",
            }),
          };
        }
        if (callCount === 2) {
          // Get chat members - fails (missing permission)
          return {
            ok: false,
            status: 403,
            statusText: "Forbidden",
            text: async () => "Missing permission",
          };
        }
        // Create sharing link with organization scope
        return {
          ok: true,
          json: async () => ({
            link: { webUrl: "https://sharepoint.example.com/org-fallback" },
          }),
        };
      }) as unknown as typeof fetch;

      const result = await uploadAndShareSharePoint({
        buffer: Buffer.from("pdf-data"),
        filename: "doc.pdf",
        tokenProvider,
        siteId: "site-123",
        chatId: "chat-456",
        usePerUserSharing: true,
        fetchFn: mockFetch,
      });

      // Should still succeed with org scope fallback
      expect(result.shareUrl).toBe("https://sharepoint.example.com/org-fallback");
    });
  });
});
