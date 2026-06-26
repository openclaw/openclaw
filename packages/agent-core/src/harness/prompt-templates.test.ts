// Agent Core tests cover prompt templates behavior.
import { describe, expect, it } from "vitest";
import {
  formatPromptTemplateInvocation,
  parseCommandArgs,
  substituteArgs,
} from "./prompt-template-arguments.js";

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

  it("formats prompt template invocations with apostrophes and quoted spans", () => {
    const template = {
      name: "repair",
      description: "Repair prompt",
      content: "Args: $ARGUMENTS\nFirst: $1\nSecond: $2",
    };
    const args = parseCommandArgs("don't 'quoted text' next");

    expect(formatPromptTemplateInvocation(template, args)).toBe(
      "Args: don't quoted text next\nFirst: don't\nSecond: quoted text",
    );
  });

  it("treats an unbalanced quote as a literal but still honors balanced quotes", () => {
    expect(parseCommandArgs(`don't "quote this"`)).toEqual(["don't", "quote this"]);
  });

  it("groups an unmatched double quote to the end of input", () => {
    expect(parseCommandArgs(`say "hello world`)).toEqual(["say", "hello world"]);
    expect(parseCommandArgs(`"unterminated`)).toEqual(["unterminated"]);
    expect(parseCommandArgs(`a"b`)).toEqual(["ab"]);
    const args = parseCommandArgs(`say "hello world`);
    expect(substituteArgs("[$1][$2]", args)).toBe("[say][hello world]");
  });

  it("groups an unmatched single quote with no later apostrophe to the end of input", () => {
    expect(parseCommandArgs("say 'hello world")).toEqual(["say", "hello world"]);
    expect(parseCommandArgs("'lonely")).toEqual(["lonely"]);
    expect(parseCommandArgs("--title='hi there")).toEqual(["--title=hi there"]);
    const args = parseCommandArgs("say 'hello world");
    expect(substituteArgs("[$1][$2]", args)).toBe("[say][hello world]");
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

  it("groups bare embedded single-quote concatenation", () => {
    expect(parseCommandArgs("foo'bar baz' next")).toEqual(["foobar baz", "next"]);
    const args = parseCommandArgs("foo'bar baz' next");
    expect(substituteArgs("[$1][$2]", args)).toBe("[foobar baz][next]");
  });

  it("groups single-quoted prefixes with suffix text", () => {
    expect(parseCommandArgs("'foo'bar next")).toEqual(["foobar", "next"]);
    expect(parseCommandArgs("'foo'bar'baz' next")).toEqual(["foobarbaz", "next"]);
    expect(parseCommandArgs("--name='foo'bar next")).toEqual(["--name=foobar", "next"]);
    const args = parseCommandArgs("--name='foo'bar next");
    expect(substituteArgs("[$1][$2]", args)).toBe("[--name=foobar][next]");
  });

  it("groups a multi-word quoted span that closes before suffix text", () => {
    expect(parseCommandArgs("'foo bar'baz next")).toEqual(["foo barbaz", "next"]);
    expect(parseCommandArgs("--name='foo bar'baz next")).toEqual(["--name=foo barbaz", "next"]);
    const args = parseCommandArgs("'foo bar'baz next");
    expect(substituteArgs("[$1][$2]", args)).toBe("[foo barbaz][next]");
  });

  it("keeps a plural possessive literal next to a later quoted span", () => {
    expect(parseCommandArgs("fix users' 'quoted text'")).toEqual(["fix", "users'", "quoted text"]);
    const args = parseCommandArgs("fix users' 'quoted text'");
    expect(substituteArgs("[$1][$2][$3]", args)).toBe("[fix][users'][quoted text]");
  });

  it("keeps prose apostrophes literal when no span can close", () => {
    expect(parseCommandArgs("O'Brien's rock'n'roll")).toEqual(["O'Brien's", "rock'n'roll"]);
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

  it("keeps a contraction inside a balanced quoted phrase", () => {
    expect(parseCommandArgs("'it's a test' next")).toEqual(["it's a test", "next"]);
    expect(parseCommandArgs(`"don't stop" now`)).toEqual(["don't stop", "now"]);
    const args = parseCommandArgs("'it's a test' next");
    expect(substituteArgs("[$1][$2]", args)).toBe("[it's a test][next]");
  });

  it("keeps a contraction literal before a later standalone quoted span", () => {
    expect(parseCommandArgs("don't 'quoted text' next")).toEqual(["don't", "quoted text", "next"]);
    expect(parseCommandArgs("it's a 'test case' here")).toEqual(["it's", "a", "test case", "here"]);
    const args = parseCommandArgs("don't 'quoted text' next");
    expect(substituteArgs("[$1][$2][$3]", args)).toBe("[don't][quoted text][next]");
  });

  it("keeps contractions literal before a later attached single-quote span", () => {
    expect(parseCommandArgs("don't foo'bar baz' next")).toEqual(["don't", "foobar baz", "next"]);
    expect(parseCommandArgs("we're foo'bar baz' next")).toEqual(["we're", "foobar baz", "next"]);
    const args = parseCommandArgs("don't foo'bar baz' next");
    expect(substituteArgs("[$1][$2][$3]", args)).toBe("[don't][foobar baz][next]");
  });

  it("keeps multi-apostrophe prose words literal before a later attached span", () => {
    expect(parseCommandArgs("O'Brien's foo'bar baz' next")).toEqual([
      "O'Brien's",
      "foobar baz",
      "next",
    ]);
    expect(parseCommandArgs("rock'n'roll foo'bar baz' next")).toEqual([
      "rock'n'roll",
      "foobar baz",
      "next",
    ]);
  });

  it("keeps irregular contractions literal before a later attached span", () => {
    expect(parseCommandArgs("y'all foo'bar baz' next")).toEqual(["y'all", "foobar baz", "next"]);
    expect(parseCommandArgs("ma'am foo'bar baz' next")).toEqual(["ma'am", "foobar baz", "next"]);
    expect(parseCommandArgs("o'clock foo'bar baz' next")).toEqual([
      "o'clock",
      "foobar baz",
      "next",
    ]);
    expect(parseCommandArgs("Y'all 'quoted text' next")).toEqual(["Y'all", "quoted text", "next"]);
    const args = parseCommandArgs("y'all foo'bar baz' next");
    expect(substituteArgs("[$1][$2][$3]", args)).toBe("[y'all][foobar baz][next]");
  });

  it("keeps any prose contraction literal without a fixed word list", () => {
    expect(parseCommandArgs("ne'er foo'bar baz' next")).toEqual(["ne'er", "foobar baz", "next"]);
    expect(parseCommandArgs("cap'n foo'bar baz' next")).toEqual(["cap'n", "foobar baz", "next"]);
    expect(parseCommandArgs("y'know foo'bar baz' next")).toEqual(["y'know", "foobar baz", "next"]);
    expect(parseCommandArgs("fo'c'sle foo'bar baz' next")).toEqual([
      "fo'c'sle",
      "foobar baz",
      "next",
    ]);
    expect(parseCommandArgs("'y'all here'")).toEqual(["y'all here"]);
    const args = parseCommandArgs("ne'er foo'bar baz' next");
    expect(substituteArgs("[$1][$2][$3]", args)).toBe("[ne'er][foobar baz][next]");
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
