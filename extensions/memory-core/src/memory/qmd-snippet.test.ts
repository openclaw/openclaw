import { describe, expect, it } from "vitest";
import { parseQmdSnippet } from "./qmd-snippet.js";

describe("parseQmdSnippet", () => {
  it.each([
    ["@@ -7,1\nrouter backup", "router backup", 7, 7],
    ["@@ -7,2 @@ (6 before, 0 after)\nrouter\nbackup", "router\nbackup", 7, 8],
    ["\uFEFF@@ -2,1 @@ (1 before, 3 after)\r\ncontent\r\n", "content\r\n", 2, 2],
  ])("parses raw QMD envelopes", (raw, snippet, startLine, endLine) => {
    expect(parseQmdSnippet(raw)).toEqual({
      snippet,
      startLine,
      endLine,
      strippedEnvelope: true,
    });
  });

  it("parses the numbered MCP envelope including blank lines", () => {
    expect(
      parseQmdSnippet(
        "11: @@ -10,4 @@ (9 before, 0 after)\n12: first\n13:\n14: 12: document prose\n",
      ),
    ).toEqual({
      snippet: "first\n\n12: document prose\n",
      startLine: 10,
      endLine: 13,
      strippedEnvelope: true,
    });
  });

  it("does not partially strip nonconsecutive MCP numbering", () => {
    expect(parseQmdSnippet("11: @@ -10,2 @@ (9 before, 0 after)\n12: first\n14: second")).toEqual({
      snippet: "12: first\n14: second",
      startLine: 10,
      endLine: 11,
      strippedEnvelope: true,
    });
  });

  it.each([
    "12: ordinary prose",
    "prefix\n@@ -7,1\ncontent",
    "@@ -0,1\ncontent",
    "@@ -1,0\ncontent",
    "@@ --1,1\ncontent",
    "@@ -9007199254740992,1\ncontent",
    "11: @@ -10,1 @@ trailing junk\n12: content",
  ])("preserves non-envelope content: %s", (snippet) => {
    expect(parseQmdSnippet(snippet)).toEqual({ snippet, strippedEnvelope: false });
  });

  it("strips only one envelope", () => {
    expect(parseQmdSnippet("@@ -1,2\n@@ -8,1\nreal content").snippet).toBe("@@ -8,1\nreal content");
  });
});
