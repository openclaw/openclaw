// Memory Core tests cover concept vocabulary plugin behavior.
import { describe, expect, it } from "vitest";
import {
  deriveConceptTags,
  summarizeConceptTagScriptCoverage,
  isJunkConceptTag,
} from "./concept-vocabulary.js";

describe("concept vocabulary", () => {
  it("extracts Unicode-aware concept tags for common European languages", () => {
    const tags = deriveConceptTags({
      path: "memory/2026-04-04.md",
      snippet:
        "Configuración de gateway, configuration du routeur, Sicherung und Überwachung Glacier.",
    });

    expect(tags).toStrictEqual([
      "gateway",
      "glacier",
      "routeur",
      "sicherung",
      "überwachung",
      "configuración",
      "configuration",
    ]);
    expect(tags).not.toContain("de");
    expect(tags).not.toContain("du");
    expect(tags).not.toContain("und");
    expect(tags).not.toContain("2026-04-04.md");
  });

  it("preserves short protected-glossary terms past the latin minimum-length gate", () => {
    const tags = deriveConceptTags({
      path: "memory/2026-04-04.md",
      snippet: "Store the session in kv and back up to s3 nightly.",
    });

    // "kv" and "s3" are 2-char latin glossary entries that the generic min-length-3 gate would drop.
    expect(tags).toContain("kv");
    expect(tags).toContain("s3");
  });

  it("does not surface short glossary terms that only appear inside longer words", () => {
    const tags = deriveConceptTags({
      path: "memory/2026-04-04.md",
      snippet: "Played the mkv recording and tuned the css3 layout.",
    });

    // "kv"/"s3" are substrings of "mkv"/"css3"; whole-word matching must not emit them as tags.
    expect(tags).not.toContain("kv");
    expect(tags).not.toContain("s3");
    expect(tags).toContain("mkv");
    expect(tags).toContain("css3");
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

  it("drops chat scaffolding stop words from derived concept tags", () => {
    const tags = deriveConceptTags({
      path: "memory/.dreams/session-corpus/2026-04-16.txt",
      snippet:
        "Assistant: the system should remind you about the Ollama provider setup in your workspace.",
    });

    expect(tags).toContain("ollama");
    expect(tags).toContain("provider");
    expect(tags).not.toContain("assistant");
    expect(tags).not.toContain("system");
    expect(tags).not.toContain("the");
    expect(tags).not.toContain("you");
    expect(tags).not.toContain("your");
  });

  it("ignores project and recall annotations when deriving concept tags", () => {
    const tags = deriveConceptTags({
      path: "memory/2026-07-28.md",
      snippet:
        "Alpha ingest workflow. <!-- project: github.com/acme/alpha --> <!-- trigger: kraken deploy ritual --> <!-- importance: 8 -->",
    });

    expect(tags).toContain("alpha");
    expect(tags).toContain("ingest");
    expect(tags).not.toContain("github.com/acme/alpha");
    expect(tags).not.toContain("acme");
    expect(tags).not.toContain("kraken");
    expect(tags).not.toContain("importance");
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

  // New tests for issue #111923: Dreaming REM phase extracts junk topics
  describe("junk topic filtering (issue #111923)", () => {
    it("filters out stop words like 'kept' and 'theme'", () => {
      const tags = deriveConceptTags({
        path: "memory/2026-08-01.md",
        snippet: "The theme kept appearing in the conversation about the project.",
      });

      expect(tags).not.toContain("kept");
      expect(tags).not.toContain("theme");
      expect(tags).toContain("project");
      expect(tags).toContain("conversation");
      expect(tags).toContain("appearing");
    });

    it("filters out bare numbers like '1.00'", () => {
      const tags = deriveConceptTags({
        path: "memory/2026-08-01.md",
        snippet: "The price was 1.00 and the total came to 42.50 for the items.",
      });

      expect(tags).not.toContain("1.00");
      expect(tags).not.toContain("42.50");
      expect(tags).toContain("price");
      expect(tags).toContain("total");
      expect(tags).toContain("items");
    });

    it("filters out number ranges like '51-54'", () => {
      const tags = deriveConceptTags({
        path: "memory/2026-08-01.md",
        snippet: "Pages 51-54 discuss the router configuration and backup procedures.",
      });

      expect(tags).not.toContain("51-54");
      expect(tags).toContain("pages");
      expect(tags).toContain("discuss");
      expect(tags).toContain("router");
      expect(tags).toContain("configuration");
      expect(tags).toContain("backup");
      expect(tags).toContain("procedures");
    });

    it("filters out pure integers", () => {
      const tags = deriveConceptTags({
        path: "memory/2026-08-01.md",
        snippet: "There were 42 items and 7 categories in the database.",
      });

      expect(tags).not.toContain("42");
      expect(tags).not.toContain("7");
      expect(tags).toContain("items");
      expect(tags).toContain("categories");
      expect(tags).toContain("database");
    });

    it("extracts meaningful topics from REM phase sample data", () => {
      // Simulate REM phase extraction on sample data that might contain junk
      const tags = deriveConceptTags({
        path: "memory/2026-08-01.md",
        snippet:
          "User discussed router configuration and backup strategies. The theme kept recurring. Pages 51-54 and section 1.00 were referenced.",
      });

      // Verify junk is filtered
      expect(tags).not.toContain("kept");
      expect(tags).not.toContain("theme");
      expect(tags).not.toContain("1.00");
      expect(tags).not.toContain("51-54");

      // Verify meaningful topics are extracted (limited to MAX_CONCEPT_TAGS=8)
      expect(tags).toContain("router");
      expect(tags).toContain("configuration");
      expect(tags).toContain("backup");
      expect(tags).toContain("strategies");
      expect(tags).toContain("discussed");
      expect(tags).toContain("recurring");
      // Note: "referenced" may be cut off due to MAX_CONCEPT_TAGS limit
    });
  });

  describe("isJunkConceptTag (REM aggregation filter)", () => {
    it("filters legacy persisted junk tags", () => {
      expect(isJunkConceptTag("kept")).toBe(true);
      expect(isJunkConceptTag("theme")).toBe(true);
      expect(isJunkConceptTag("1.00")).toBe(true);
      expect(isJunkConceptTag("42")).toBe(true);
      expect(isJunkConceptTag("51-54")).toBe(true);
    });

    it("allows meaningful tags", () => {
      expect(isJunkConceptTag("router")).toBe(false);
      expect(isJunkConceptTag("configuration")).toBe(false);
      expect(isJunkConceptTag("backup")).toBe(false);
    });
  });
});
