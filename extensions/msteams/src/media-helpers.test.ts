// Msteams tests cover media helpers plugin behavior.
import { describe, expect, it } from "vitest";
import { extractFilename, extractMessageId, getMimeType, isLocalPath } from "./media-helpers.js";

describe("msteams media-helpers", () => {
  describe("getMimeType", () => {
    it("handles URLs with query strings", async () => {
      expect(await getMimeType("https://example.com/image.png?v=123")).toBe("image/png");
    });

    it("reads MIME from a data URL", async () => {
      expect(await getMimeType("data:image/png;base64,iVBORw0KGgo=")).toBe("image/png");
    });

    it("handles data URLs without base64", async () => {
      expect(await getMimeType("data:image/svg+xml,%3Csvg")).toBe("image/svg+xml");
    });

    it("defaults to application/octet-stream for unknown extensions", async () => {
      expect(await getMimeType("https://example.com/image")).toBe("application/octet-stream");
      expect(await getMimeType("https://example.com/image.unknown")).toBe(
        "application/octet-stream",
      );
    });

    it("is case-insensitive", async () => {
      expect(await getMimeType("https://example.com/IMAGE.PNG")).toBe("image/png");
      expect(await getMimeType("https://example.com/Photo.JPEG")).toBe("image/jpeg");
    });
  });

  describe("extractFilename", () => {
    it("extracts filename from URL with path", async () => {
      expect(await extractFilename("https://example.com/images/2024/photo.png")).toBe("photo.png");
    });

    it.each([
      ["https://example.com/files/My%20report.pdf", "My report.pdf"],
      ["https://example.com/files/r%C3%A9sum%C3%A9.pdf", "résumé.pdf"],
      ["https://example.com/files/100%25.png", "100%.png"],
      ["https://example.com/files/bad%ZZ.pdf", "bad%ZZ.pdf"],
      ["https://example.com/files/folder%2Fsecret.png", "folder%2Fsecret.png"],
      ["https://example.com/files/folder%5Csecret.png", "folder%5Csecret.png"],
    ])("preserves the safe display filename from %s", async (url, expected) => {
      expect(await extractFilename(url)).toBe(expected);
    });

    it("handles URLs without extension by deriving from MIME", async () => {
      // Now defaults to application/octet-stream → .bin fallback
      expect(await extractFilename("https://example.com/images/photo")).toBe("photo.bin");
    });

    it("derives an image filename from a data URL", async () => {
      expect(await extractFilename("data:image/png;base64,iVBORw0KGgo=")).toBe("image.png");
    });

    it("handles document data URLs", async () => {
      expect(await extractFilename("data:application/pdf;base64,JVBERi0")).toBe("file.pdf");
    });

    it("returns fallback for empty URL", async () => {
      expect(await extractFilename("")).toBe("file.bin");
    });

    it("extracts original filename from embedded pattern", async () => {
      // Pattern: {original}---{uuid}.{ext}
      expect(
        await extractFilename("/media/inbound/report---a1b2c3d4-e5f6-7890-abcd-ef1234567890.pdf"),
      ).toBe("report.pdf");
    });
  });

  describe("isLocalPath", () => {
    it("returns true for file:// URLs", () => {
      expect(isLocalPath("file:///tmp/image.png")).toBe(true);
      expect(isLocalPath("file://localhost/tmp/image.png")).toBe(true);
      expect(isLocalPath("FILE:///C:/Users/test/image.png")).toBe(true);
    });

    it("returns true for absolute paths", () => {
      expect(isLocalPath("/tmp/image.png")).toBe(true);
      expect(isLocalPath("/Users/test/photo.jpg")).toBe(true);
    });

    it("returns true for tilde paths", () => {
      expect(isLocalPath("~/Downloads/image.png")).toBe(true);
    });

    it("returns true for Windows absolute drive paths", () => {
      expect(isLocalPath("C:\\Users\\test\\image.png")).toBe(true);
      expect(isLocalPath("D:/data/photo.jpg")).toBe(true);
    });

    it("returns true for Windows UNC paths", () => {
      expect(isLocalPath("\\\\server\\share\\image.png")).toBe(true);
    });

    it("returns true for Windows rooted paths", () => {
      expect(isLocalPath("\\tmp\\openclaw\\file.txt")).toBe(true);
    });

    it("returns false for http URLs", () => {
      expect(isLocalPath("http://example.com/image.png")).toBe(false);
      expect(isLocalPath("https://example.com/image.png")).toBe(false);
    });

    it("returns false for data URLs", () => {
      expect(isLocalPath("data:image/png;base64,iVBORw0KGgo=")).toBe(false);
    });
  });

  describe("extractMessageId", () => {
    it("extracts id from valid response", () => {
      expect(extractMessageId({ id: "msg123" })).toBe("msg123");
    });

    it("returns null for missing id", () => {
      expect(extractMessageId({ foo: "bar" })).toBeNull();
    });

    it("returns null for empty id", () => {
      expect(extractMessageId({ id: "" })).toBeNull();
    });

    it("returns null for non-string id", () => {
      expect(extractMessageId({ id: 123 })).toBeNull();
      expect(extractMessageId({ id: null })).toBeNull();
    });

    it("returns null for null response", () => {
      expect(extractMessageId(null)).toBeNull();
    });

    it("returns null for non-object response", () => {
      expect(extractMessageId("string")).toBeNull();
      expect(extractMessageId(123)).toBeNull();
    });
  });
});
