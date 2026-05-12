import { describe, expect, it } from "vitest";
import { expandQueryForFts, extractKeywords } from "./query-expansion.js";

describe("extractKeywords", () => {
  it("extracts keywords from English conversational query", () => {
    const keywords = extractKeywords("that thing we discussed about the API");
    expect(keywords).toStrictEqual(["discussed", "api"]);
  });

  it("extracts keywords from Chinese conversational query", () => {
    const keywords = extractKeywords("之前讨论的那个方案");
    expect(keywords).toContain("讨论");
    expect(keywords).toContain("方案");
    // Should not include stop words
    expect(keywords).not.toContain("之前");
    expect(keywords).not.toContain("的");
    expect(keywords).not.toContain("那个");
  });

  it("extracts keywords from mixed language query", () => {
    const keywords = extractKeywords("昨天讨论的 API design");
    expect(keywords).toContain("讨论");
    expect(keywords).toContain("api");
    expect(keywords).toContain("design");
  });

  it("returns specific technical terms", () => {
    const keywords = extractKeywords("what was the solution for the CFR bug");
    expect(keywords).toStrictEqual(["solution", "cfr", "bug"]);
  });

  it("extracts keywords from Korean conversational query", () => {
    const keywords = extractKeywords("어제 논의한 배포 전략");
    expect(keywords).toStrictEqual(["논의한", "배포", "전략"]);
  });

  it("strips Korean particles to extract stems", () => {
    const keywords = extractKeywords("서버에서 발생한 에러를 확인");
    expect(keywords).toStrictEqual(["서버에서", "서버", "발생한", "에러를", "에러", "확인"]);
  });

  it("filters Korean stop words including inflected forms", () => {
    const keywords = extractKeywords("나는 그리고 그래서");
    expect(keywords).not.toContain("나");
    expect(keywords).not.toContain("나는");
    expect(keywords).not.toContain("그리고");
    expect(keywords).not.toContain("그래서");
  });

  it("filters inflected Korean stop words not explicitly listed", () => {
    const keywords = extractKeywords("그녀는 우리는");
    expect(keywords).not.toContain("그녀는");
    expect(keywords).not.toContain("우리는");
    expect(keywords).not.toContain("그녀");
    expect(keywords).not.toContain("우리");
  });

  it("does not produce bogus single-char stems from particle stripping", () => {
    const keywords = extractKeywords("논의");
    expect(keywords).toContain("논의");
    expect(keywords).not.toContain("논");
  });

  it("strips longest Korean trailing particles first", () => {
    const keywords = extractKeywords("기능으로 설명");
    expect(keywords).toStrictEqual(["기능으로", "기능", "설명"]);
  });

  it("keeps stripped ASCII stems for mixed Korean tokens", () => {
    const keywords = extractKeywords("API를 배포했다");
    expect(keywords).toStrictEqual(["api를", "api", "배포했다"]);
  });

  it("handles mixed Korean and English query", () => {
    const keywords = extractKeywords("API 배포에 대한 논의");
    expect(keywords).toContain("api");
    expect(keywords).toContain("배포");
    expect(keywords).toContain("논의");
  });

  it("extracts keywords from Japanese conversational query", () => {
    const keywords = extractKeywords("昨日話したデプロイ戦略");
    expect(keywords).toContain("デプロイ");
    expect(keywords).toContain("戦略");
    expect(keywords).not.toContain("昨日");
  });

  it("handles mixed Japanese and English query", () => {
    const keywords = extractKeywords("昨日話したAPIのバグ");
    expect(keywords).toContain("api");
    expect(keywords).toContain("バグ");
    expect(keywords).not.toContain("した");
  });

  it("filters Japanese stop words", () => {
    const keywords = extractKeywords("これ それ そして どう");
    expect(keywords).not.toContain("これ");
    expect(keywords).not.toContain("それ");
    expect(keywords).not.toContain("そして");
    expect(keywords).not.toContain("どう");
  });

  it("extracts keywords from Spanish conversational query", () => {
    const keywords = extractKeywords("ayer hablamos sobre la estrategia de despliegue");
    expect(keywords).toStrictEqual(["hablamos", "estrategia", "despliegue"]);
  });

  it("extracts keywords from Portuguese conversational query", () => {
    const keywords = extractKeywords("ontem falamos sobre a estratégia de implantação");
    expect(keywords).toStrictEqual(["falamos", "estratégia", "implantação"]);
  });

  it("filters Spanish and Portuguese question stop words", () => {
    const keywords = extractKeywords("cómo cuando donde porquê quando onde");
    expect(keywords).not.toContain("cómo");
    expect(keywords).not.toContain("cuando");
    expect(keywords).not.toContain("donde");
    expect(keywords).not.toContain("porquê");
    expect(keywords).not.toContain("quando");
    expect(keywords).not.toContain("onde");
  });

  it("extracts keywords from Arabic conversational query", () => {
    const keywords = extractKeywords("بالأمس ناقشنا استراتيجية النشر");
    expect(keywords).toStrictEqual(["ناقشنا", "استراتيجية", "النشر"]);
  });

  it("filters Arabic question stop words", () => {
    const keywords = extractKeywords("كيف متى أين ماذا");
    expect(keywords).not.toContain("كيف");
    expect(keywords).not.toContain("متى");
    expect(keywords).not.toContain("أين");
    expect(keywords).not.toContain("ماذا");
  });

  it("handles empty query", () => {
    expect(extractKeywords("")).toStrictEqual([]);
    expect(extractKeywords("   ")).toStrictEqual([]);
  });

  it("handles query with only stop words", () => {
    const keywords = extractKeywords("the a an is are");
    expect(keywords).toStrictEqual([]);
  });

  it("removes duplicate keywords", () => {
    const keywords = extractKeywords("test test testing");
    expect(keywords).toStrictEqual(["test", "testing"]);
  });

  describe("with trigram tokenizer", () => {
    const trigramOpts = { ftsTokenizer: "trigram" as const };

    it("emits whole CJK block instead of unigrams in trigram mode", () => {
      const defaultKeywords = extractKeywords("之前讨论的那个方案");
      const trigramKeywords = extractKeywords("之前讨论的那个方案", trigramOpts);
      // Default mode produces bigrams
      expect(defaultKeywords).toContain("讨论");
      expect(defaultKeywords).toContain("方案");
      // Trigram mode emits the whole contiguous CJK block (FTS5 trigram
      // requires >= 3 chars per term; individual characters return no results)
      expect(trigramKeywords).toContain("之前讨论的那个方案");
      expect(trigramKeywords).not.toContain("讨论");
      expect(trigramKeywords).not.toContain("方案");
    });

    it("skips Japanese kanji bigrams in trigram mode", () => {
      const defaultKeywords = extractKeywords("経済政策について");
      const trigramKeywords = extractKeywords("経済政策について", trigramOpts);
      // Default mode adds kanji bigrams: 経済, 済政, 政策
      expect(defaultKeywords).toContain("経済");
      expect(defaultKeywords).toContain("済政");
      expect(defaultKeywords).toContain("政策");
      // Trigram mode keeps the full kanji block but skips bigram splitting
      expect(trigramKeywords).toContain("経済政策");
      expect(trigramKeywords).not.toContain("済政");
    });

    it("still filters stop words in trigram mode", () => {
      const keywords = extractKeywords("これ それ そして どう", trigramOpts);
      expect(keywords).not.toContain("これ");
      expect(keywords).not.toContain("それ");
      expect(keywords).not.toContain("そして");
      expect(keywords).not.toContain("どう");
    });

    it("does not affect English keyword extraction", () => {
      const keywords = extractKeywords("that thing we discussed about the API", trigramOpts);
      expect(keywords).toContain("discussed");
      expect(keywords).toContain("api");
      expect(keywords).not.toContain("that");
      expect(keywords).not.toContain("the");
    });
  });
});

describe("expandQueryForFts", () => {
  it("returns original query and extracted keywords", () => {
    const result = expandQueryForFts("that API we discussed");
    expect(result).toStrictEqual({
      original: "that API we discussed",
      keywords: ["api", "discussed"],
      expanded: "that API we discussed OR api OR discussed",
    });
  });

  it("builds expanded OR query for FTS", () => {
    const result = expandQueryForFts("the solution for bugs");
    expect(result).toStrictEqual({
      original: "the solution for bugs",
      keywords: ["solution", "bugs"],
      expanded: "the solution for bugs OR solution OR bugs",
    });
  });

  it("returns original query when no keywords extracted", () => {
    const result = expandQueryForFts("the");
    expect(result).toStrictEqual({
      original: "the",
      keywords: [],
      expanded: "the",
    });
  });
});
