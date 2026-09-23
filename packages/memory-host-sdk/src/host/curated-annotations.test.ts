import { describe, expect, it } from "vitest";
import {
  INVALID_PROJECT_ANNOTATION_KEY,
  extractCuratedEntryRecallMetadata,
  extractProjectKeysFromCuratedEntry,
  stripMemoryAnnotationCarriers,
} from "./curated-annotations.js";

describe("curated annotation grammar", () => {
  it.each([
    ["<!--\n trigger: x -->", ""],
    ["<!--trigger\n: x -->", ""],
    ["<!--trigger:\n x -->", "<!--trigger:\n x -->"],
    ["<!--trigger:\n<!--importance: 7 -->", "<!--trigger:\n"],
    ["<!--trigger:x <!--\nimportance:7 -->", "<!--trigger:x"],
    ["text <!--note: visible -->", "text <!--note: visible -->"],
    ["a \t<!--trigger: x -->\r\nb \tX", "a\r\nb \tX"],
  ])("strips carriers without changing the grammar of %j", (input, expected) => {
    expect(stripMemoryAnnotationCarriers(input)).toBe(expected);
  });

  it.each([
    ["<!-- trigger: <!-- project: alpha -->", true, ["alpha"], 1, 1],
    ["<!-- project: outer <!-- project: inner -->", false, [], 1, 0],
    ["<!--project: a;\n b -->", true, ["a", "b"], 2, 2],
    ["<!--project: a; a -->", true, ["a"], 2, 2],
    ["<!--project: \n a\n -->", true, ["a"], 1, 1],
    ["<!--project: a\n b -->", false, [], 1, 0],
    ["<!--project: a --> <!--project:", false, ["a"], 1, 1],
  ])("preserves project scope for %j", (input, valid, keys, rawCount, validCount) => {
    expect(extractProjectKeysFromCuratedEntry(input)).toEqual({
      annotated: true,
      valid,
      keys,
      rawCount,
      validCount,
    });
  });

  it("preserves suffix selection, value validation, and ordered trigger deduplication", () => {
    expect(
      extractCuratedEntryRecallMetadata({
        curatedRoot: true,
        projectScopeEligible: true,
        sourceLines: [
          "body <!--TRIGGER: alpha, beta; alpha --> prose <!-- note --><!--importance: 03 -->",
          "<!--trigger: ignored --> trailing text",
          "<!--importance: 11 --><!--importance: 8 --><!--importance: 2.5 -->",
          "<!--trigger: gamma --><!--project: GitHub.com/Owner/Repo -->",
        ],
      }),
    ).toEqual({
      triggers: "alpha; beta; gamma",
      importance: 8,
      projectKey: "github.com/Owner/Repo",
    });
  });

  it("keeps long unfinished carriers unchanged and invalid project markers scoped", () => {
    const openers = "<!--project:".repeat(20_000);
    const spaces = `<!--project:${" ".repeat(20_000)}X`;
    for (const input of [openers, spaces]) {
      expect(stripMemoryAnnotationCarriers(input)).toBe(input);
      expect(extractProjectKeysFromCuratedEntry(input)).toEqual({
        annotated: true,
        valid: false,
        keys: [],
        rawCount: 0,
        validCount: 0,
      });
    }
  });

  it("parses incomplete recall annotations without pathological backtracking", () => {
    const sourceLines = [`- Incomplete. <!--trigger:${"--><!--project:".repeat(26)}X`];
    // #138995's exponential suffix regex took 44 s on this 417-character witness.
    // Time only the sub-millisecond parser; 2 s leaves ample scheduling headroom.
    const started = performance.now();
    const metadata = extractCuratedEntryRecallMetadata({
      sourceLines,
      curatedRoot: true,
      projectScopeEligible: true,
    });
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(2_000);
    expect(metadata).toEqual({
      importance: null,
      triggers: null,
      projectKey: INVALID_PROJECT_ANNOTATION_KEY,
    });
  });
});
