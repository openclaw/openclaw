// OC Path tests cover frontmatter edges plugin behavior.
import { describe, expect, it } from "vitest";
import { parseMd } from "../../parse.js";

describe("frontmatter-edges", () => {
  it("BOM before frontmatter open is tolerated", () => {
    const ast = parseMd("﻿---\nname: bom\n---\n");
    expect(ast.frontmatter[0]?.value).toBe("bom");
  });
});
