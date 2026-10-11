// Memory Host SDK tests cover query keyword extraction behavior.
import { describe, expect, it } from "vitest";
import { extractKeywords } from "./query-expansion.js";

describe("extractKeywords", () => {
  it("keeps ASCII terms embedded in unspaced Chinese text", () => {
    const keywords = extractKeywords("用react部署k8s集群");
    expect(keywords).toStrictEqual(["react", "部", "署", "部署", "k8s", "集", "群", "集群"]);
  });

  it("keeps stripped ASCII stems for mixed Korean tokens", () => {
    const keywords = extractKeywords("API를 배포했다");
    expect(keywords).toStrictEqual(["api를", "api", "배포했다"]);
  });

  it("handles mixed Korean and English query", () => {
    const keywords = extractKeywords("API 배포에 대한 논의");
    expect(keywords).toStrictEqual(["api", "배포에", "배포", "대한", "논의"]);
  });

  describe("with trigram tokenizer", () => {
    const trigramOpts = { ftsTokenizer: "trigram" as const };

    it("emits whole CJK block instead of unigrams in trigram mode", () => {
      const defaultKeywords = extractKeywords("之前讨论的那个方案");
      const trigramKeywords = extractKeywords("之前讨论的那个方案", trigramOpts);
      expect(defaultKeywords).toStrictEqual([
        "之",
        "讨",
        "论",
        "个",
        "方",
        "案",
        "前讨",
        "讨论",
        "论的",
        "的那",
        "个方",
        "方案",
      ]);
      expect(trigramKeywords).toStrictEqual(["之前讨论的那个方案"]);
    });

    it("skips Japanese kanji bigrams in trigram mode", () => {
      const defaultKeywords = extractKeywords("経済政策について");
      const trigramKeywords = extractKeywords("経済政策について", trigramOpts);
      expect(defaultKeywords).toStrictEqual(["経済政策", "経済", "済政", "政策", "について"]);
      expect(trigramKeywords).toStrictEqual(["経済政策", "について"]);
    });
  });
});
