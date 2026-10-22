// OC Path tests cover parse plugin behavior.
import { describe, expect, it } from "vitest";
import { parseMd } from "../parse.js";

describe("parseMd — frontmatter", () => {
  it.each([
    [String.raw`"line\nnext\tcolumn"`, "line\nnext\tcolumn"],
    [String.raw`"\x41\u0042"`, "AB"],
    ["'don''t'", "don't"],
    [String.raw`'C:\Tools\bin'`, String.raw`C:\Tools\bin`],
    [String.raw`"bad\qescape"`, String.raw`bad\qescape`],
    ["true", "true"],
    ["123", "123"],
  ])("reads quoted scalar %s without changing plain string semantics", (encoded, value) => {
    const raw = `---\nnote: ${encoded}\n---\n`;
    const ast = parseMd(raw);
    expect(ast.frontmatter[0]?.value).toBe(value);
    expect(ast.raw).toBe(raw);
  });

  it("strips quotes from values", () => {
    const raw = `---
title: "Hello world"
hint: 'quoted'
---
`;
    const ast = parseMd(raw);
    expect(ast.frontmatter[0]?.value).toBe("Hello world");
    expect(ast.frontmatter[1]?.value).toBe("quoted");
  });
});

describe("parseMd — byte-fidelity", () => {
  it("preserves BOM in raw but ignores it for parsing", () => {
    const raw = "﻿## Heading\n";
    const ast = parseMd(raw);
    expect(ast.raw).toBe(raw);
    expect(ast.blocks[0]?.heading).toBe("Heading");
  });
});
