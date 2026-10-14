// OC Path tests cover malformed input plugin behavior.
import { describe, expect, it } from "vitest";
import { parseMd } from "../../parse.js";

describe("malformed-input", () => {
  it("truncated mid-frontmatter (no close fence)", () => {
    const raw = "---\nname: github\n";
    const { ast, diagnostics } = parseMd(raw);
    expect(diagnostics.some((d) => d.code === "OC_FRONTMATTER_UNCLOSED")).toBe(true);
    expect(ast.frontmatter).toEqual([]);
  });

  it("file with mixed indentation extremes (tabs, spaces, mixed)", () => {
    const raw = "## H\n\t- tabbed\n  - spaced\n\t  - mixed\n";
    expect(() => parseMd(raw)).not.toThrow();
  });
});
