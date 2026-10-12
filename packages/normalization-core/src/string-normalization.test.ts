import { describe, expect, it } from "vitest";
import {
  containsAsciiControlCharacter,
  filterStringEntries,
  normalizeAtHashSlug,
  normalizeCsvOrLooseStringList,
  normalizeHyphenSlug,
  normalizeOptionalTrimmedStringList,
  normalizeSortedUniqueStringEntries,
  normalizeSortedUniqueTrimmedStringList,
  normalizeStringEntries,
  normalizeTrimmedStringList,
  normalizeUniqueSingleOrTrimmedStringList,
  normalizeUniqueStringEntries,
  normalizeUniqueStringEntriesLower,
  normalizeUniqueTrimmedStringList,
} from "./string-normalization.js";

describe("normalization-core/string-normalization", () => {
  it.each([
    { label: "C1", value: String.fromCharCode(0x80, 0x9f), expected: false },
    { label: "NUL", value: `branch${String.fromCharCode(0)}name`, expected: true },
    { label: "DEL", value: `branch${String.fromCharCode(0x7f)}name`, expected: true },
  ])("detects only ASCII controls: $label", ({ value, expected }) => {
    expect(containsAsciiControlCharacter(value)).toBe(expected);
  });

  it.each([
    { value: "value", expected: [] },
    {
      value: ["", "  ", 1, "first", null, "first", Object("boxed"), "last\n"],
      expected: ["", "  ", "first", "first", "last\n"],
    },
  ])("filters runtime strings from $value", ({ value, expected }) => {
    expect(filterStringEntries(value)).toEqual(expected);
  });

  it("normalizes mixed allow-list entries", () => {
    expect(normalizeStringEntries([" a ", 42, "", "  ", "z"])).toEqual(["a", "42", "z"]);
    expect(normalizeStringEntries([" ok ", null, { toString: () => " obj " }])).toEqual([
      "ok",
      "null",
      "obj",
    ]);
    expect(normalizeStringEntries(undefined)).toStrictEqual([]);
  });

  it("normalizes unique string entries", () => {
    expect(normalizeUniqueStringEntries([" b ", "a", "b", "", 4, "a"])).toEqual(["b", "a", "4"]);
  });

  it("normalizes unique lowercase string entries", () => {
    expect(normalizeUniqueStringEntriesLower([" A ", "a", "MiXeD", "", 7])).toEqual([
      "a",
      "mixed",
      "7",
    ]);
  });

  it("normalizes sorted unique string entries", () => {
    expect(normalizeSortedUniqueStringEntries([" b ", "a", "b", "", 4])).toEqual(["4", "a", "b"]);
  });

  it("normalizes unique trimmed string lists", () => {
    expect(normalizeUniqueTrimmedStringList([" b ", "a", "b", "", "a"])).toEqual(["b", "a"]);
    expect(normalizeUniqueTrimmedStringList("b")).toEqual([]);
  });

  it("normalizes array-backed trimmed string lists", () => {
    const values = [" first ", "", 42, " second ", null];
    expect(normalizeTrimmedStringList(values)).toEqual(["first", "second"]);
    expect(normalizeTrimmedStringList("first")).toEqual([]);
    expect(normalizeOptionalTrimmedStringList(values)).toEqual(["first", "second"]);
    expect(normalizeOptionalTrimmedStringList(["", 42])).toBeUndefined();
  });

  it.each([
    { value: " first, second, , first ", expected: ["first", "second", "first"] },
    { value: [" first ", 42, "", "  ", 7], expected: ["first", "42", "7"] },
    { value: null, expected: [] },
  ])("normalizes CSV or loose string-list input", ({ value, expected }) => {
    expect(normalizeCsvOrLooseStringList(value)).toEqual(expected);
  });

  it("normalizes sorted unique trimmed string lists", () => {
    expect(normalizeSortedUniqueTrimmedStringList([" b ", 1, "a", "b", "", "a"])).toEqual([
      "a",
      "b",
    ]);
  });

  it("normalizes unique single-or-list string values", () => {
    expect(normalizeUniqueSingleOrTrimmedStringList([" b ", "a", "b", "", "a"])).toEqual([
      "b",
      "a",
    ]);
    expect(normalizeUniqueSingleOrTrimmedStringList(" b ")).toEqual(["b"]);
  });

  it("normalizes slug-like labels while preserving supported symbols", () => {
    expect(normalizeHyphenSlug(" #My_Channel + Alerts ")).toBe("#my_channel-+-alerts");
    expect(normalizeHyphenSlug(undefined)).toBe("");
  });

  it("normalizes @/# prefixed slugs used by channel allowlists", () => {
    expect(normalizeAtHashSlug(" #My_Channel + Alerts ")).toBe("my-channel-alerts");
    expect(normalizeAtHashSlug("@@Room___Name")).toBe("room-name");
    expect(normalizeAtHashSlug(undefined)).toBe("");
  });
});
