import { describe, expect, it } from "vitest";
import { createPdfDocumentExtractor } from "./document-extractor.js";

// A 518-byte PDF that uses Helvetica, one of the 14 standard PDF fonts.
// Without `standardFontDataUrl`, pdf.js emits
// `UnknownErrorException: Ensure that the standardFontDataUrl API parameter
// is provided` for this PDF and returns empty text. Embedded inline so the
// test does not depend on a binary fixture file.
const HELLO_PDF_BASE64 =
  "JVBERi0xLjQKJeLjz9MKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PgplbmRvYmoKMiAwIG9iago8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PgplbmRvYmoKMyAwIG9iago8PC9UeXBlL1BhZ2UvUGFyZW50IDIgMCBSL01lZGlhQm94WzAgMCA2MTIgNzkyXS9Db250ZW50cyA0IDAgUi9SZXNvdXJjZXM8PC9Gb250PDwvRjE8PC9UeXBlL0ZvbnQvU3VidHlwZS9UeXBlMS9CYXNlRm9udC9IZWx2ZXRpY2E+Pj4+Pj4+PgplbmRvYmoKNCAwIG9iago8PC9MZW5ndGggNDc+PnN0cmVhbQpCVCAvRjEgMjQgVGYgMTAwIDcwMCBUZCAoSGVsbG8gUERGIFdvcmxkKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCnhyZWYKMCA1CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAxNSAwMDAwMCBuIAowMDAwMDAwMDYwIDAwMDAwIG4gCjAwMDAwMDAxMTEgMDAwMDAgbiAKMDAwMDAwMDI2NCAwMDAwMCBuIAp0cmFpbGVyCjw8L1NpemUgNS9Sb290IDEgMCBSPj4Kc3RhcnR4cmVmCjM1OAolJUVPRgo=";

const helloPdfBuffer = Buffer.from(HELLO_PDF_BASE64, "base64");

describe("PDF document extractor with standard fonts", () => {
  it("extracts text from a PDF that uses a standard font (Helvetica)", async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(" "));
    };

    try {
      const extractor = createPdfDocumentExtractor();
      const result = await extractor.extract({
        buffer: helloPdfBuffer,
        mimeType: "application/pdf",
        maxPages: 1,
        maxPixels: 2_000_000,
        minTextChars: 5,
      });

      expect(result.text).toContain("Hello PDF World");
      expect(result.images).toHaveLength(0);

      const fontWarnings = warnings.filter((w) => w.includes("standardFontDataUrl"));
      expect(fontWarnings).toEqual([]);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("reuses the cached standard-font path across calls", async () => {
    const extractor = createPdfDocumentExtractor();
    const first = await extractor.extract({
      buffer: helloPdfBuffer,
      mimeType: "application/pdf",
      maxPages: 1,
      maxPixels: 2_000_000,
      minTextChars: 5,
    });
    const second = await extractor.extract({
      buffer: helloPdfBuffer,
      mimeType: "application/pdf",
      maxPages: 1,
      maxPixels: 2_000_000,
      minTextChars: 5,
    });

    expect(first.text).toBe(second.text);
    expect(first.text).toContain("Hello PDF World");
  });
});
