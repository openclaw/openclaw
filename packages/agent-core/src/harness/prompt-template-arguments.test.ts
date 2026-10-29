import { describe, expect, it } from "vitest";
import { parseCommandArgs, substituteArgs } from "./prompt-template-arguments.js";

describe("prompt template arguments", () => {
  it("parses quoted and multiline arguments", () => {
    expect(parseCommandArgs(`alpha "beta gamma"\ndelta 'echo one two'`)).toEqual([
      "alpha",
      "beta gamma",
      "delta",
      "echo one two",
    ]);
  });

  it("preserves quoted empty arguments so positional placeholders stay aligned", () => {
    expect(parseCommandArgs('first "" third')).toEqual(["first", "", "third"]);
    expect(parseCommandArgs("first '' third")).toEqual(["first", "", "third"]);
    expect(substituteArgs("$1|$2|$3", parseCommandArgs('first "" third'))).toBe("first||third");
  });

  it("preserves literal dollar sequences in $ARGUMENTS and $@ substitution", () => {
    const args = parseCommandArgs("price $$ and $& here");
    expect(substituteArgs("Args: $ARGUMENTS", args)).toBe("Args: price $$ and $& here");
    expect(substituteArgs("Args: $@", args)).toBe("Args: price $$ and $& here");
  });

  it("resolves every placeholder in one pass so inserted arguments are never re-expanded", () => {
    expect(substituteArgs("$1 $@", ["$ARGUMENTS", "safe"])).toBe("$ARGUMENTS $ARGUMENTS safe");
    expect(substituteArgs("$1 ${@:2:1}", ["$@", "$ARGUMENTS", "safe"])).toBe("$@ $ARGUMENTS");
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
