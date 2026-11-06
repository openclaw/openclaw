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
    ["|-\n  alpha\n  beta", "alpha\nbeta"],
    ["|\n  alpha\n  beta", "alpha\nbeta\n"],
    ["|+\n  alpha\n  beta\n", "alpha\nbeta\n\n"],
    [">-\n  alpha\n  beta", "alpha beta"],
    ['"alpha\n  beta"', "alpha beta"],
    ["'alpha\n  beta'", "alpha beta"],
    ["alpha\n  beta", "alpha beta"],
    ...["ready#literal", "00123", "true", "123", "null", "[]", "{}"].map((value) => [value, value]),
  ])("reads string scalar %s without changing non-string spelling", (encoded, value) => {
    const raw = `---\nnote: ${encoded}\nfollowing: 'quoted'\n---\n`;
    const ast = parseMd(raw);
    expect(ast.frontmatter).toEqual([
      { key: "note", value, line: 2 },
      { key: "following", value: "quoted", line: encoded.split("\n").length + 2 },
    ]);
    expect(ast.raw).toBe(raw);
  });

  it("reads block-style structured values instead of an empty string", () => {
    const raw = "---\nauthors:\n  - alice\n  - bob\nmeta:\n  a: 1\n  b: 2\nflow: {a: 1}\n---\n";
    const ast = parseMd(raw);
    expect(ast.frontmatter).toEqual([
      { key: "authors", value: "- alice\n- bob", line: 2 },
      { key: "meta", value: "a: 1\nb: 2", line: 5 },
      { key: "flow", value: "{a: 1}", line: 8 },
    ]);
    expect(ast.raw).toBe(raw);
  });

  it("keeps block values when malformed siblings force the tolerant line reader", () => {
    const raw =
      "---\nsummary: |\n  line one\n  line two\nauthors:\n  - alice\nbroken: [unclosed\n---\n";
    const ast = parseMd(raw);
    expect(ast.frontmatter).toEqual([
      { key: "summary", value: "line one\nline two\n", line: 2 },
      { key: "authors", value: "- alice", line: 5 },
      { key: "broken", value: "[unclosed", line: 7 },
    ]);
    expect(ast.raw).toBe(raw);
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
