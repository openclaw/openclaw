// OC Path tests cover parse plugin behavior.
import { describe, expect, it } from "vitest";
import { parseMd } from "../parse.js";

describe("parseMd", () => {
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
    ...["\n 00123", "\n false", "\n null", "00123", "", "ready"].map((v) => [`${v} #`, v.trim()]),
    ["ready\n...", "ready"],
    ["|-\n  alpha\n  beta", "alpha\nbeta"],
    ["|\n  alpha\n  beta", "alpha\nbeta\n"],
    ["|+\n  alpha\n  beta\n", "alpha\nbeta\n\n"],
    [">-\n  alpha\n  beta", "alpha beta"],
    ['"alpha\n  beta"', "alpha beta", "inline"],
    ["'alpha\n  beta'", "alpha beta", "inline"],
    ["[alice,\n  bob]", "[alice,\n  bob]", "inline"],
    ["{name: alice,\n  role: admin}", "{name: alice,\n  role: admin}", "inline"],
    ['["a#b", bob] # note', '["a#b", bob]', "inline"],
    ["&ids [alice, bob]", "&ids [alice, bob]", "inline"],
    ["!!seq [alice, bob]", "!!seq [alice, bob]", "inline"],
    ["alpha\n  beta", "alpha beta", "inline"],
    ["\n  - alice\n  - bob", "- alice\n- bob"],
    ["\n  nested:\n    a: 1\n    b: 2", "nested:\n  a: 1\n  b: 2"],
    ["\n  - *person", "- *person"],
    ...["ready#literal", "00123", "true", "123", "null", "[]", "{}", "---"].map((v) => [v, v]),
  ])("reads frontmatter %s without changing non-string spelling", (encoded, value, mode = "") => {
    for (const following of mode === "inline" ? ["quoted"] : ["quoted", "[unclosed"]) {
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
  it("derives the same slug for mixed underscores, punctuation, and hyphens", () => {
    const raw = "## Alpha_ ?_-Beta\u00a0__Gamma\n";
    const ast = parseMd(raw);
    expect(ast.blocks[0]?.slug).toBe("alpha-beta-gamma");
  });

  it("preserves BOM in raw but ignores it for parsing", () => {
    const raw = "﻿## Heading\n";
    expect(parseMd(raw)).toMatchObject({ raw, blocks: [{ heading: "Heading" }] });
  });
});
