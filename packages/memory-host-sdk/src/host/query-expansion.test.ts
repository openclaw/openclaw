// Memory Host SDK tests cover query keyword extraction behavior.
import { describe, expect, it } from "vitest";
import { extractKeywords } from "./query-expansion.js";

describe("extractKeywords", () => {
  for (const [name, query, expected] of [
    [
      "extracts keywords from English conversational query",
      "that thing we discussed about the API",
      ["discussed", "api"],
    ],
    [
      "extracts keywords from Chinese conversational query",
      "之前讨论的那个方案",
      ["之", "讨", "论", "个", "方", "案", "前讨", "讨论", "论的", "的那", "个方", "方案"],
    ],
    [
      "extracts keywords from mixed language query",
      "昨天讨论的 API design",
      ["昨", "天", "讨", "论", "天讨", "讨论", "论的", "api", "design"],
    ],
    [
      "keeps ASCII terms embedded in unspaced Chinese text",
      "用react部署k8s集群",
      ["react", "部", "署", "部署", "k8s", "集", "群", "集群"],
    ],
    [
      "returns specific technical terms",
      "what was the solution for the CFR bug",
      ["solution", "cfr", "bug"],
    ],
    [
      "extracts keywords from Korean conversational query",
      "어제 논의한 배포 전략",
      ["논의한", "배포", "전략"],
    ],
    [
      "strips Korean particles to extract stems",
      "서버에서 발생한 에러를 확인",
      ["서버에서", "서버", "발생한", "에러를", "에러", "확인"],
    ],
    ["filters Korean stop words including inflected forms", "나는 그리고 그래서", []],
    ["filters inflected Korean stop words not explicitly listed", "그녀는 우리는", []],
    ["does not produce bogus single-char stems from particle stripping", "논의", ["논의"]],
    [
      "strips longest Korean trailing particles first",
      "기능으로 설명",
      ["기능으로", "기능", "설명"],
    ],
    [
      "keeps stripped ASCII stems for mixed Korean tokens",
      "API를 배포했다",
      ["api를", "api", "배포했다"],
    ],
    [
      "handles mixed Korean and English query",
      "API 배포에 대한 논의",
      ["api", "배포에", "배포", "대한", "논의"],
    ],
    [
      "extracts keywords from Japanese conversational query",
      "昨日話したデプロイ戦略",
      ["昨日話", "日話", "デプロイ", "戦略"],
    ],
    [
      "handles mixed Japanese and English query",
      "昨日話したAPIのバグ",
      ["昨日話", "日話", "api", "バグ"],
    ],
    ["filters Japanese stop words", "これ それ そして どう", []],
    [
      "extracts keywords from Spanish conversational query",
      "ayer hablamos sobre la estrategia de despliegue",
      ["hablamos", "estrategia", "despliegue"],
    ],
    [
      "extracts keywords from Portuguese conversational query",
      "ontem falamos sobre a estratégia de implantação",
      ["falamos", "estratégia", "implantação"],
    ],
    [
      "filters Spanish and Portuguese question stop words",
      "cómo cuando donde porquê quando onde",
      [],
    ],
    [
      "extracts keywords from Arabic conversational query",
      "بالأمس ناقشنا استراتيجية النشر",
      ["ناقشنا", "استراتيجية", "النشر"],
    ],
    ["filters Arabic question stop words", "كيف متى أين ماذا", []],
  ] as const) {
    it(name, () => {
      const keywords = extractKeywords(query);
      expect(keywords).toStrictEqual(expected);
    });
  }

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

    it("splits Han runs around embedded ASCII terms in trigram mode", () => {
      const keywords = extractKeywords("用react部署方案", trigramOpts);
      expect(keywords).toStrictEqual(["react", "部署方案"]);
    });

    it("skips Japanese kanji bigrams in trigram mode", () => {
      const defaultKeywords = extractKeywords("経済政策について");
      const trigramKeywords = extractKeywords("経済政策について", trigramOpts);
      expect(defaultKeywords).toStrictEqual(["経済政策", "経済", "済政", "政策", "について"]);
      expect(trigramKeywords).toStrictEqual(["経済政策", "について"]);
    });

    it("still filters stop words in trigram mode", () => {
      const keywords = extractKeywords("これ それ そして どう", trigramOpts);
      expect(keywords).toStrictEqual([]);
    });

    it("does not affect English keyword extraction", () => {
      const keywords = extractKeywords("that thing we discussed about the API", trigramOpts);
      expect(keywords).toStrictEqual(["discussed", "api"]);
    });
  });
});
