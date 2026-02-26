import { describe, expect, it } from "vitest";
import { alignArticles } from "./article-aligner.js";

describe("article-aligner", () => {
  it("aligns Arabic المادة الثالثة with English Article 3", () => {
    const result = alignArticles({ الثالثة: "نص المادة الثالثة" }, [
      { articleId: "3", text: "Article 3 english" },
    ]);
    expect(result.aligned[0]?.articleId).toBe("3");
    expect(result.aligned[0]?.englishText).toContain("Article 3");
  });

  it("creates partial pair for unmatched Arabic article", () => {
    const result = alignArticles({ الرابعة: "Arabic only" }, []);
    expect(result.aligned).toHaveLength(1);
    expect(result.aligned[0]?.arabicText).toContain("Arabic only");
    expect(result.aligned[0]?.englishText).toBe("");
  });

  it("creates partial pair for unmatched English article", () => {
    const result = alignArticles({}, [{ articleId: "9", text: "English only" }]);
    expect(result.aligned).toHaveLength(1);
    expect(result.aligned[0]?.arabicText).toBe("");
    expect(result.aligned[0]?.englishText).toContain("English only");
  });

  it("extracts glossary from quoted means pattern", () => {
    const result = alignArticles({ الأولى: '"Company" means "الشركة"' }, [
      { articleId: "1", text: '"Company" means "The Employer"' },
    ]);
    expect(result.glossary.length).toBeGreaterThan(0);
    expect(result.glossary[0]?.arabicTerm).toContain("Company");
  });
});
