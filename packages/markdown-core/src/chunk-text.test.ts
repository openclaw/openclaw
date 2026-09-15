// Markdown Core tests cover plain-text chunking behavior.
import { describe, expect, it } from "vitest";
import { chunkText } from "./chunk-text.js";

describe("chunkText", () => {
  it("normalizes positive fractional limits without emitting empty chunks", () => {
    expect(chunkText("abc", 0.5)).toEqual(["a", "b", "c"]);
    expect(chunkText("😀😀", 0.5)).toEqual(["😀", "😀"]);
  });

  it.each<[string, number, string[]]>([
    ["Heads up now (Though now I'm curious)ok", 35, ["Heads up now", "(Though now I'm curious)ok"]],
    ["Hello (outer (inner) end) world", 26, ["Hello (outer (inner) end)", "world"]],
    ["Hello) world (ok)", 12, ["Hello)", "world (ok)"]],
    ["alpha beta   ", 8, ["alpha", "beta   "]],
  ])("preserves readable boundaries and raw remainder for %j", (text, limit, expected) => {
    expect(chunkText(text, limit)).toEqual(expected);
  });
});
