import { describe, expect, it } from "vitest";
import { resolveOncharPrefixes, stripOncharPrefix } from "./monitor-onchar.js";

describe("Mattermost onchar activation", () => {
  it("uses defaults for absent or blank prefixes", () => {
    expect(resolveOncharPrefixes(undefined)).toEqual([">", "!"]);
    expect(resolveOncharPrefixes([" ", ""])).toEqual([">", "!"]);
  });
  it("strips the first configured prefix after normalization", () => {
    expect(stripOncharPrefix("   ??hello", resolveOncharPrefixes([" ?? ", " ? "]))).toEqual({
      triggered: true,
      stripped: "hello",
    });
  });
  it("preserves text when no prefix matches", () => {
    expect(stripOncharPrefix("hello world", ["!", ">"])).toEqual({
      triggered: false,
      stripped: "hello world",
    });
  });
});
