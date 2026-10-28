import { describe, expect, it } from "vitest";
import * as strings from "./string-normalization.js";

describe("normalization-core/string-normalization", () => {
  it.each([
    ["", "value", 0],
    ["same", "same", 4],
    ["prefix", "pre", 3],
    ["abX", "abY", 2],
    ["A", "a", 0],
    ["\ud83d\ude00", "\ud83d\ude01", 1],
    ["é", "e\u0301", 0],
  ])("counts the raw UTF-16 prefix of %j and %j", (left, right, expected) => {
    expect(strings.commonPrefixLength(left, right)).toBe(expected);
  });

  it.each([
    ["", false],
    ["fix/a&b λ\u0080\u009f", false],
    ["branch\0name", true],
    ["branch\u001f", true],
    ["branch\u007fname", true],
  ])("detects only ASCII controls: %j", (value, expected) => {
    expect(strings.containsAsciiControlCharacter(value)).toBe(expected);
  });

  it.each([
    [{ 0: "value" }, []],
    [
      ["", 1, "x", null, "x", Object("x"), "\n"],
      ["", "x", "x", "\n"],
    ],
  ])("filters runtime strings from %j", (value, expected) => {
    expect(strings.filterStringEntries(value)).toEqual(expected);
  });

  it("normalizes mixed allow-list entries", () => {
    expect(strings.normalizeStringEntries([null, { toString: () => " x " }])).toEqual([
      "null",
      "x",
    ]);
    expect(strings.normalizeStringEntries(undefined)).toStrictEqual([]);
  });

  it.each([
    [
      ["a", "Z", "10", "2", "A", ""],
      ["", "10", "2", "A", "Z", "a"],
    ],
    [
      ["\ue000", "\ud83d\ude00", "\ud800", "\udc00", "é", "e\u0301", "é"],
      ["e\u0301", "é", "\ud800", "\ud83d\ude00", "\udc00", "\ue000"],
    ],
  ])("sorts fresh unique strings from iterables: %j", (values, expected) => {
    const input = Object.freeze(values);
    const result = strings.sortUniqueStrings(input);
    expect(result).toEqual(expected);
    expect(result).not.toBe(input);
    expect(strings.sortUniqueStrings(new Set(input))).toEqual(expected);
    expect(strings.sortUniqueStrings(input.values())).toEqual(expected);
  });

  it.each([
    [strings.normalizeUniqueStringEntries, ["b", "a", "4", "MiXeD", "B"]],
    [strings.normalizeUniqueStringEntriesLower, ["b", "a", "4", "mixed"]],
    [strings.normalizeSortedUniqueStringEntries, ["4", "B", "MiXeD", "a", "b"]],
    [strings.normalizeUniqueTrimmedStringList, ["b", "a", "MiXeD", "B"]],
    [strings.normalizeSortedUniqueTrimmedStringList, ["B", "MiXeD", "a", "b"]],
    [strings.normalizeUniqueSingleOrTrimmedStringList, ["b", "a", "MiXeD", "B"]],
  ])("normalizes unique lists with %s", (normalize, expected) => {
    expect(normalize([" b ", "a", "b", "", 4, "a", "MiXeD", "B"])).toEqual(expected);
  });

  it("normalizes array-backed trimmed string lists", () => {
    const values = [" first ", "", 42, " second ", null];
    expect(strings.normalizeOptionalTrimmedStringList(values)).toEqual(["first", "second"]);
    expect(strings.normalizeOptionalTrimmedStringList(["", 42])).toBeUndefined();
  });

  it.each([
    [" first, second, , first ", ["first", "second", "first"]],
    [
      [" first ", 42, "", "  ", 7],
      ["first", "42", "7"],
    ],
    [null, []],
  ])("normalizes CSV or loose string-list input %j", (value, expected) => {
    expect(strings.normalizeCsvOrLooseStringList(value)).toEqual(expected);
  });

  it("distinguishes array-only from single-or-list input", () => {
    expect(strings.normalizeUniqueTrimmedStringList("b")).toEqual([]);
    expect(strings.normalizeUniqueSingleOrTrimmedStringList(" b ")).toEqual(["b"]);
  });

  it.each([
    [" #My_Channel + Alerts ", "#my_channel-+-alerts"],
    [undefined, ""],
    ["  ...Hello   /  World---  ", "hello-world"],
    [" ###Team@@@Room### ", "###team@@@room###"],
    ["Team 中文 Команда فريق", "team-中文-команда-فريق"],
    ["Cafe\u0301 हिन्दी", "café-हिन्दी"],
  ])("normalizes permissive slugs: %s", (input, expected) => {
    expect(strings.normalizeHyphenSlug(input)).toBe(expected);
  });

  it.each([
    [" #My_Channel + Alerts ", "my-channel-alerts"],
    ["@@Room___Name", "room-name"],
    [undefined, ""],
    ["@@@___", ""],
    ["#中文 Команда فريق", "中文-команда-فريق"],
    ["@Cafe\u0301_हिन्दी", "café-हिन्दी"],
  ])("normalizes strict slugs: %s", (input, expected) => {
    expect(strings.normalizeAtHashSlug(input)).toBe(expected);
  });
});
