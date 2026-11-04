// Msteams tests cover media helpers plugin behavior.
import { describe, expect, it } from "vitest";
import { extractFilename, extractMessageId } from "./media-helpers.js";

describe("msteams media-helpers", () => {
  describe("extractFilename", () => {
    it.each([
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
  });

  describe("extractMessageId", () => {
    it("returns null for missing id", () => {
      expect(extractMessageId({ foo: "bar" })).toBeNull();
    });

    it("returns null for empty id", () => {
      expect(extractMessageId({ id: "" })).toBeNull();
    });
  });
});
