// OC Path tests cover parse plugin behavior.
import { describe, expect, it } from "vitest";
import { parseMd } from "../parse.js";

describe("parseMd — frontmatter", () => {
  it("emits diagnostic for unclosed frontmatter", () => {
    const raw = `---
name: github
description: never closes

Body.
`;
    const { diagnostics } = parseMd(raw);
    expect(diagnostics).toStrictEqual([
      {
        line: 1,
        message: "frontmatter opens with --- but never closes",
        severity: "warning",
        code: "OC_FRONTMATTER_UNCLOSED",
      },
    ]);
  });

  it("strips quotes from values", () => {
    const raw = `---
title: "Hello world"
hint: 'quoted'
---
`;
    const { ast } = parseMd(raw);
    expect(ast.frontmatter[0]?.value).toBe("Hello world");
    expect(ast.frontmatter[1]?.value).toBe("quoted");
  });
});

describe("parseMd — byte-fidelity", () => {
  it("preserves BOM in raw but ignores it for parsing", () => {
    const raw = "﻿## Heading\n";
    const { ast } = parseMd(raw);
    expect(ast.raw).toBe(raw);
    expect(ast.blocks[0]?.heading).toBe("Heading");
  });
});
