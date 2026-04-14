import { describe, expect, it } from "vitest";
import { resolveQmdCollectionPatternFlags } from "./qmd-compat.js";

describe("resolveQmdCollectionPatternFlags", () => {
  it("prefers legacy --mask by default and falls back to --glob", () => {
    expect(resolveQmdCollectionPatternFlags(null)).toEqual(["--mask", "--glob"]);
  });

  it("keeps preferring --glob after a glob-capable qmd succeeds", () => {
    expect(resolveQmdCollectionPatternFlags("--glob")).toEqual(["--glob", "--mask"]);
  });

  it("keeps preferring legacy --mask after a legacy-only qmd succeeds", () => {
    expect(resolveQmdCollectionPatternFlags("--mask")).toEqual(["--mask", "--glob"]);
  });
});
