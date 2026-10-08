// Terminal Core tests cover osc progress behavior.
import { describe, expect, it } from "vitest";
import { formatOscProgress, supportsOscProgress } from "./osc-progress.js";

describe("OSC progress", () => {
  it("detects supported terminal environments", () => {
    expect(supportsOscProgress({ TERM_PROGRAM: "WezTerm" }, true)).toBe(true);
    expect(supportsOscProgress({ TERM_PROGRAM: "Apple_Terminal" }, true)).toBe(false);
    expect(supportsOscProgress({ WT_SESSION: "1" }, false)).toBe(false);
  });

  it("formats OSC 9;4 progress sequences", () => {
    expect([formatOscProgress(3, 0), formatOscProgress(1, 42.6), formatOscProgress(0, 0)]).toEqual([
      "\u001b]9;4;3;0\u001b\\",
      "\u001b]9;4;1;43\u001b\\",
      "\u001b]9;4;0;0\u001b\\",
    ]);
  });
});
