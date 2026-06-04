import { describe, expect, it } from "vitest";
import { parseCommandArgs, substituteArgs } from "./prompt-templates.js";

describe("prompt template argument substitution", () => {
  it("parses quoted and multiline arguments", () => {
    expect(parseCommandArgs(`alpha "beta gamma"\ndelta 'echo one two'`)).toEqual([
      "alpha",
      "beta gamma",
      "delta",
      "echo one two",
    ]);
  });

  it("keeps apostrophes in prose instead of dropping them", () => {
    expect(parseCommandArgs("fix the user's login bug")).toEqual([
      "fix",
      "the",
      "user's",
      "login",
      "bug",
    ]);
    expect(parseCommandArgs("it's broken now")).toEqual(["it's", "broken", "now"]);
  });

  it("preserves apostrophes through $ARGUMENTS and positional placeholders", () => {
    const args = parseCommandArgs("fix the user's login bug");
    expect(substituteArgs("Please address: $ARGUMENTS", args)).toBe(
      "Please address: fix the user's login bug",
    );
    const positional = parseCommandArgs("it's broken now");
    expect(substituteArgs("[$1][$2]", positional)).toBe("[it's][broken]");
  });

  it("treats an unbalanced quote as a literal but still honors balanced quotes", () => {
    expect(parseCommandArgs(`don't "quote this"`)).toEqual(["don't", "quote this"]);
  });

  it("keeps apostrophes literal across multiple contractions", () => {
    expect(parseCommandArgs("don't it's broken now")).toEqual(["don't", "it's", "broken", "now"]);
    const args = parseCommandArgs("don't it's broken now");
    expect(substituteArgs("$ARGUMENTS", args)).toBe("don't it's broken now");
    expect(substituteArgs("[$1][$2][$3][$4]", args)).toBe("[don't][it's][broken][now]");
  });

  it("groups shell-style quoted spans embedded in a token", () => {
    expect(parseCommandArgs(`--title="two words" next`)).toEqual(["--title=two words", "next"]);
    expect(parseCommandArgs("foo='bar baz' next")).toEqual(["foo=bar baz", "next"]);
    const args = parseCommandArgs(`--title="two words" next`);
    expect(substituteArgs("[$1][$2]", args)).toBe("[--title=two words][next]");
  });

  it("keeps apostrophes literal after non-ASCII word characters", () => {
    expect(parseCommandArgs("José's don't fail")).toEqual(["José's", "don't", "fail"]);
    const args = parseCommandArgs("José's don't fail");
    expect(substituteArgs("$ARGUMENTS", args)).toBe("José's don't fail");
    expect(substituteArgs("[$1][$2][$3]", args)).toBe("[José's][don't][fail]");
  });

  it("does not close an unmatched leading quote on a later contraction", () => {
    expect(parseCommandArgs("'review don't fail")).toEqual(["'review", "don't", "fail"]);
    const args = parseCommandArgs("'review don't fail");
    expect(substituteArgs("[$1][$2][$3]", args)).toBe("['review][don't][fail]");
  });

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
