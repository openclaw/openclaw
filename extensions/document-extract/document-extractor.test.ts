import { describe, expect, it } from "vitest";
import { createPdfDocumentExtractor } from "./document-extractor.js";

describe("PDF document extractor", () => {
  it("declares PDF support", () => {
    const extractor = createPdfDocumentExtractor();
    expect(extractor).toMatchObject({
      id: "pdf",
      label: "PDF",
      mimeTypes: ["application/pdf"],
    });
  });
});
