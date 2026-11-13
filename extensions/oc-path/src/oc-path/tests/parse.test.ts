// OC Path tests cover parse plugin behavior.
import { describe, expect, it } from "vitest";
import { parseMd } from "../parse.js";

describe("parseMd — frontmatter", () => {
  it.each([
    ['"Hello world"', "Hello world"],
    [String.raw`"line\nnext\tcolumn"`, "line\nnext\tcolumn"],
    [String.raw`"\x41\u0042"`, "AB"],
    ["'don''t'", "don't"],
    [String.raw`"line\nnext" # comment`, "line\nnext"],
    ["'don''t' # comment", "don't"],
    [String.raw`"literal # hash" # comment`, "literal # hash"],
    [String.raw`"bad\qescape" # comment`, String.raw`"bad\qescape" # comment`],
    [String.raw`'C:\Tools\bin'`, String.raw`C:\Tools\bin`],
    [String.raw`"bad\qescape"`, String.raw`bad\qescape`],
    ["ready # operator note", "ready"],
    ["ready\n...", "ready"],
    ["|-\n  alpha\n  beta", "alpha\nbeta", "fallback"],
    ["|\n  alpha\n  beta", "alpha\nbeta\n", "fallback"],
    ["|+\n  alpha\n  beta\n", "alpha\nbeta\n\n", "fallback"],
    [">-\n  alpha\n  beta", "alpha beta", "fallback"],
    ['"alpha\n  beta"', "alpha beta"],
    ["'alpha\n  beta'", "alpha beta"],
    ["alpha\n  beta", "alpha beta"],
    ["\n  - alice\n  - bob", "- alice\n- bob", "fallback"],
    ["\n  nested:\n    a: 1\n    b: 2", "nested:\n  a: 1\n  b: 2", "fallback"],
    ["\n  - *person", "- *person", "fallback"],
    ...["ready#literal", "00123", "true", "123", "null", "[]", "{}"].map((value) => [value, value]),
  ])("reads frontmatter %s without changing non-string spelling", (encoded, value, mode = "") => {
    for (const following of mode === "fallback" ? ["quoted", "[unclosed"] : ["quoted"]) {
      const raw = `\uFEFF---\nprimary: &person alice\nnote: ${encoded}\nfollowing: ${following === "quoted" ? "'quoted'" : following}\n---\n`;
      const ast = parseMd(raw);
      expect(ast.frontmatter).toEqual([
        { key: "primary", value: "alice", line: 2 },
        { key: "note", value, line: 3 },
        { key: "following", value: following, line: encoded.split("\n").length + 3 },
      ]);
      expect(ast.raw).toBe(raw);
    }
  });
});

describe("parseMd — byte-fidelity", () => {
  it("derives the same slug for mixed underscores, punctuation, and hyphens", () => {
    const raw = "## Alpha_ ?_-Beta\u00a0__Gamma\n";
    const ast = parseMd(raw);
    expect(ast.blocks[0]?.slug).toBe("alpha-beta-gamma");
  });

  it("preserves BOM in raw but ignores it for parsing", () => {
    const raw = "﻿## Heading\n";
    const ast = parseMd(raw);
    expect(ast.raw).toBe(raw);
    expect(ast.blocks[0]?.heading).toBe("Heading");
  });
});
