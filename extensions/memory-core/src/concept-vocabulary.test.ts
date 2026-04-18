import { describe, expect, it } from "vitest";
import {
  classifyConceptTagScript,
  deriveConceptTags,
  summarizeConceptTagScriptCoverage,
} from "./concept-vocabulary.js";

describe("concept vocabulary", () => {
  it("extracts Unicode-aware concept tags for common European languages", () => {
    const tags = deriveConceptTags({
      path: "memory/2026-04-04.md",
      snippet:
        "Configuración de gateway, configuration du routeur, Sicherung und Überwachung Glacier.",
    });

    expect(tags).toEqual(
      expect.arrayContaining([
        "gateway",
        "configuración",
        "configuration",
        "routeur",
        "sicherung",
        "überwachung",
        "glacier",
      ]),
    );
    expect(tags).not.toContain("de");
    expect(tags).not.toContain("du");
    expect(tags).not.toContain("und");
    expect(tags).not.toContain("2026-04-04.md");
  });

  it("extracts protected and segmented CJK concept tags", () => {
    const tags = deriveConceptTags({
      path: "memory/2026-04-04.md",
      snippet:
        "障害対応ルーター設定とバックアップ確認。路由器备份与网关同步。라우터 백업 페일오버 점검.",
    });

    expect(tags).toEqual(
      expect.arrayContaining([
        "障害対応",
        "ルーター",
        "バックアップ",
        "路由器",
        "备份",
        "网关",
        "라우터",
        "백업",
      ]),
    );
    expect(tags).not.toContain("ルー");
    expect(tags).not.toContain("ター");
  });

  it("classifies concept tags by script family", () => {
    expect(classifyConceptTagScript("routeur")).toBe("latin");
    expect(classifyConceptTagScript("路由器")).toBe("cjk");
    expect(classifyConceptTagScript("qmd路由器")).toBe("mixed");
  });

  it("summarizes entry coverage across latin, cjk, and mixed tags", () => {
    expect(
      summarizeConceptTagScriptCoverage([
        ["routeur", "sauvegarde"],
        ["路由器", "备份"],
        ["qmd", "路由器"],
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

describe("stopword filtering", () => {
  it("filters common English stopwords from concept tags", () => {
    const tags = deriveConceptTags({
      path: "memory/2026-04-04.md",
      snippet: "The router was not very good but the failover can help when you have been there.",
    });

    expect(tags).toEqual(expect.arrayContaining(["router", "failover"]));
    expect(tags).not.toContain("the");
    expect(tags).not.toContain("was");
    expect(tags).not.toContain("not");
    expect(tags).not.toContain("very");
    expect(tags).not.toContain("but");
    expect(tags).not.toContain("can");
    expect(tags).not.toContain("you");
    expect(tags).not.toContain("been");
  });

  it("filters LLM transcript role markers from concept tags", () => {
    const tags = deriveConceptTags({
      path: "memory/2026-04-04.md",
      snippet:
        "assistant user role content function message response. The gateway backup completed.",
    });

    expect(tags).toEqual(expect.arrayContaining(["gateway", "backup"]));
    expect(tags).not.toContain("assistant");
    expect(tags).not.toContain("user");
    expect(tags).not.toContain("role");
    expect(tags).not.toContain("content");
    expect(tags).not.toContain("function");
    expect(tags).not.toContain("message");
    expect(tags).not.toContain("response");
  });

  it("preserves meaningful domain terms while filtering noise", () => {
    const tags = deriveConceptTags({
      path: "memory/2026-04-04.md",
      snippet: "Configured the OpenAI embedding model for the QMD router backup system.",
    });

    expect(tags).toEqual(expect.arrayContaining(["openai", "embedding", "router", "backup"]));
    expect(tags).not.toContain("the");
    expect(tags).not.toContain("for");
  });
});
