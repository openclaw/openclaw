import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";

vi.mock("mammoth", () => ({
  default: {
    extractRawText: vi.fn(),
  },
}));

import mammoth from "mammoth";
import { extractDocxArticles, splitArticlesFromRawText } from "./docx-reader.js";

describe("docx-reader", () => {
  it("detects Article 1 heading and maps articleId", async () => {
    vi.mocked(mammoth.extractRawText).mockResolvedValue({
      value: "Article 1\nBody 1\nArticle 2\nBody 2",
      messages: [],
    } as never);

    const result = await extractDocxArticles(Buffer.from("docx"));
    expect(result[0]?.articleId).toBe("1");
    expect(result[0]?.text).toContain("Article 1");
  });

  it("parses Article 12bis into articleId=12bis", () => {
    const result = splitArticlesFromRawText("Article 12bis\nSome text");
    expect(result[0]?.articleId).toBe("12bis");
  });

  it("returns single empty-keyed entry when no heading exists", () => {
    const result = splitArticlesFromRawText("No legal headings here");
    expect(result).toEqual([{ articleId: "", text: "No legal headings here" }]);
  });

  it("calls mammoth.extractRawText with buffer", async () => {
    const buffer = Buffer.from("docx");
    vi.mocked(mammoth.extractRawText).mockResolvedValue({
      value: "Article 1\nA",
      messages: [],
    } as never);
    await extractDocxArticles(buffer);
    expect(vi.mocked(mammoth.extractRawText)).toHaveBeenCalledWith({ buffer });
  });
});
