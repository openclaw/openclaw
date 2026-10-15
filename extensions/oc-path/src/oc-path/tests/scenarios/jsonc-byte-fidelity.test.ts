// OC Path tests cover jsonc byte fidelity plugin behavior.
import { describe, expect, it } from "vitest";
import { parseJsonc } from "../../jsonc/parse.js";

describe("jsonc byte-fidelity", () => {
  it("BOM preserved on raw, stripped for parse", () => {
    const raw = '﻿{ "x": 1 }';
    const { ast } = parseJsonc(raw);
    expect(ast.raw).toBe(raw);
    expect(ast.root?.kind).toBe("object");
  });

  it("malformed input still emits raw verbatim AND emits a diagnostic", () => {
    const raw = '{ broken json with "key": value }';
    const { ast, diagnostics } = parseJsonc(raw);
    expect(ast.raw).toBe(raw);
    expect(ast.root).toBeNull();
    expect(diagnostics.some((d) => d.severity === "error")).toBe(true);
  });

  it("comments-only file preserved", () => {
    const raw = "// just a comment\n/* and a block */\n";
    const { ast } = parseJsonc(raw);
    expect(ast.raw).toBe(raw);
    expect(ast.root).toBeNull();
  });
});
