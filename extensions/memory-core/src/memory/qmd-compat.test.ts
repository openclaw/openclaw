import { describe, expect, it } from "vitest";
import { resolveQmdCollectionPatternFlags } from "./qmd-compat.js";

describe("resolveQmdCollectionPatternFlags", () => {
  it("prefers --mask by default and falls back to --glob for older qmd builds", () => {
    expect(resolveQmdCollectionPatternFlags(null)).toEqual(["--mask", "--glob"]);
    expect(resolveQmdCollectionPatternFlags("--mask")).toEqual(["--mask", "--glob"]);
  });

  it("keeps preferring --glob after a glob-capable qmd succeeds", () => {
    expect(resolveQmdCollectionPatternFlags("--glob")).toEqual(["--glob", "--mask"]);
  });
});
