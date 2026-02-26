import { describe, expect, it, vi } from "vitest";

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  getDocument: vi.fn(),
}));

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  ARABIC_ARTICLE_HEADING_RE,
  extractArabicPdfText,
  sortArabicTextItems,
} from "./pdf-extractor.js";

describe("pdf-extractor", () => {
  it("sorts Arabic items by Y desc then X desc", () => {
    const sorted = sortArabicTextItems([
      { str: "b", x: 10, y: 100 },
      { str: "a", x: 20, y: 100 },
      { str: "c", x: 5, y: 90 },
    ]);
    expect(sorted.map((i) => i.str)).toEqual(["a", "b", "c"]);
  });

  it("matches Arabic article heading regex for ordinal and numeric", () => {
    expect(ARABIC_ARTICLE_HEADING_RE.test("المادة الأولى")).toBe(true);
    expect(ARABIC_ARTICLE_HEADING_RE.test("المادة 12")).toBe(true);
  });

  it("calls pdfjs getDocument with required extraction flags", async () => {
    vi.mocked(getDocument).mockReturnValue({
      promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({
          getTextContent: async () => ({
            items: [
              { str: "المادة الأولى", transform: [1, 0, 0, 1, 100, 200] },
              { str: "نص", transform: [1, 0, 0, 1, 90, 180] },
            ],
          }),
        }),
      }),
    } as never);

    const out = await extractArabicPdfText(new Uint8Array([1, 2, 3]));
    expect(out.pages.length).toBe(1);
    expect(Object.keys(out.articleTexts).length).toBe(1);

    const call = vi.mocked(getDocument).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call?.disableWorker).toBe(true);
    expect(call?.cMapPacked).toBe(true);
    const cMapUrl = call?.cMapUrl;
    expect(typeof cMapUrl === "string" ? cMapUrl : JSON.stringify(cMapUrl)).toContain(
      "pdfjs-dist/cmaps/",
    );
  });
});
