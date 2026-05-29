import { describe, expect, it } from "vitest";
import { substituteArgs } from "./prompt-templates.js";

describe("prompt template argument substitution", () => {
  it("rejects unsafe positional placeholders", () => {
    expect(substituteArgs("$9007199254740992", ["first", "second"])).toBe("");
  });

  it("rejects unsafe slice starts and lengths", () => {
    const args = ["alpha", "beta", "gamma"];

    expect(substituteArgs("${@:9007199254740992}", args)).toBe("");
    expect(substituteArgs("${@:1:9007199254740992}", args)).toBe("");
  });

  it("preserves zero slice compatibility", () => {
    expect(substituteArgs("${@:0:0}", ["alpha", "beta"])).toBe("");
    expect(substituteArgs("${@:0:1}", ["alpha", "beta"])).toBe("alpha");
  });
});
