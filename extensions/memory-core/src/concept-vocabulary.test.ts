import { describe, expect, it } from "vitest";
import { deriveConceptTags, summarizeConceptTagScriptCoverage } from "./concept-vocabulary.js";

describe("concept vocabulary", () => {
  it("respects token boundaries and grammatical stopwords", () => {
    const tags = deriveConceptTags({
      path: "memory/2026-04-04.md",
      snippet: "kv𐐀 𐐀kv s3𐐀 𐐀s3 Ich der die und mit the and",
    });
    expect(tags).toEqual(expect.arrayContaining(["kv𐐨", "𐐨kv", "s3𐐨", "𐐨s3"]));
    expect(tags).not.toContain("kv");
    expect(tags).not.toContain("s3");
    expect(tags).not.toContain("ich");
  });

  it("extracts protected and segmented CJK concept tags", () => {
    const tags = deriveConceptTags({
      path: "memory/2026-04-04.md",
      snippet:
        "障害対応ルーター設定とバックアップ確認。路由器备份与网关同步。라우터 백업 페일오버 점검.",
    });

    expect(tags).toStrictEqual([
      "バックアップ",
      "ルーター",
      "障害対応",
      "路由器",
      "备份",
      "网关",
      "라우터",
      "백업",
    ]);
    expect(tags).not.toContain("ルー");
    expect(tags).not.toContain("ター");
  });

  it("summarizes entry coverage across latin, cjk, and mixed tags", () => {
    expect(
      summarizeConceptTagScriptCoverage([
        ["routeur", "sauvegarde"],
        ["路由器", "备份"],
        ["vectors", "路由器"],
        ["сервер"],
      ]),
    ).toEqual({
      latinEntryCount: 1,
      cjkEntryCount: 1,
      mixedEntryCount: 1,
      otherEntryCount: 1,
    });
  });
});
