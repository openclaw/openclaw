// Docx document extractor tests cover .docx text extraction behavior.
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import {
  createDocxDocumentExtractor,
  extractTextFromOoxmlPart,
} from "./docx-extractor.js";

function buildDocxBuffer(parts: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(parts)) {
    zip.file(path, content);
  }
  return zip.generateAsync({ type: "nodebuffer" });
}

function wrapDocumentXml(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
}

function paragraph(...runs: string[]): string {
  return `<w:p>${runs.map((run) => `<w:r><w:t>${run}</w:t></w:r>`).join("")}</w:p>`;
}

const baseRequest = {
  mimeType:
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  maxPages: 0,
  maxPixels: 0,
  minTextChars: 0,
};

describe("DOCX document extractor", () => {
  it("declares DOCX support", () => {
    const extractor = createDocxDocumentExtractor();
    const { extract, ...descriptor } = extractor;
    expect(extract).toBeInstanceOf(Function);
    expect(descriptor).toEqual({
      id: "docx",
      label: "DOCX",
      mimeTypes: [
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ],
      autoDetectOrder: 20,
    });
  });

  it("extracts paragraph text from document.xml", async () => {
    const buffer = await buildDocxBuffer({
      "word/document.xml": wrapDocumentXml(
        paragraph("Hello, ", "world!") + paragraph("Second line."),
      ),
    });
    const extractor = createDocxDocumentExtractor();
    const result = await extractor.extract({ ...baseRequest, buffer });
    expect(result).not.toBeNull();
    expect(result?.text).toBe("Hello, world!\nSecond line.");
    expect(result?.images).toEqual([]);
  });

  it("decodes XML entities inside w:t runs", async () => {
    const buffer = await buildDocxBuffer({
      "word/document.xml": wrapDocumentXml(
        paragraph("Tom &amp; Jerry &lt;3 &quot;&apos;"),
      ),
    });
    const result = await createDocxDocumentExtractor().extract({
      ...baseRequest,
      buffer,
    });
    expect(result?.text).toBe(`Tom & Jerry <3 "'`);
  });

  it("preserves xml:space and namespaced attributes on w:t", async () => {
    const xml = wrapDocumentXml(
      `<w:p><w:r><w:t xml:space="preserve">  leading spaces  </w:t></w:r></w:p>`,
    );
    const buffer = await buildDocxBuffer({ "word/document.xml": xml });
    const result = await createDocxDocumentExtractor().extract({
      ...baseRequest,
      buffer,
    });
    expect(result?.text).toBe("  leading spaces  ");
  });

  it("includes footnotes, endnotes, headers, and footers after body text", async () => {
    const buffer = await buildDocxBuffer({
      "word/document.xml": wrapDocumentXml(paragraph("Body text")),
      "word/footnotes.xml": wrapDocumentXml(paragraph("Footnote")),
      "word/endnotes.xml": wrapDocumentXml(paragraph("Endnote")),
      "word/header1.xml": wrapDocumentXml(paragraph("Header")),
      "word/footer1.xml": wrapDocumentXml(paragraph("Footer")),
    });
    const result = await createDocxDocumentExtractor().extract({
      ...baseRequest,
      buffer,
    });
    expect(result?.text).toBe("Body text\nFootnote\nEndnote\nFooter\nHeader");
  });

  it("returns an empty string when no parts contain w:t runs", async () => {
    const buffer = await buildDocxBuffer({
      "word/document.xml": wrapDocumentXml(`<w:p><w:r/></w:p>`),
    });
    const result = await createDocxDocumentExtractor().extract({
      ...baseRequest,
      buffer,
    });
    expect(result?.text).toBe("");
  });

  it("falls back gracefully when document.xml is missing", async () => {
    const buffer = await buildDocxBuffer({
      "word/footnotes.xml": wrapDocumentXml(paragraph("Only a footnote")),
    });
    const result = await createDocxDocumentExtractor().extract({
      ...baseRequest,
      buffer,
    });
    expect(result?.text).toBe("Only a footnote");
  });

  describe("extractTextFromOoxmlPart", () => {
    it("returns an empty string for empty input", () => {
      expect(extractTextFromOoxmlPart("")).toBe("");
    });

    it("joins runs within a paragraph and separates paragraphs with newlines", () => {
      const xml = `<w:p><w:r><w:t>one </w:t></w:r><w:r><w:t>two</w:t></w:r></w:p><w:p><w:r><w:t>three</w:t></w:r></w:p>`;
      expect(extractTextFromOoxmlPart(xml)).toBe("one two\nthree");
    });

    it("ignores empty paragraphs", () => {
      const xml = `<w:p></w:p><w:p><w:r><w:t>visible</w:t></w:r></w:p>`;
      expect(extractTextFromOoxmlPart(xml)).toBe("visible");
    });
  });
});
