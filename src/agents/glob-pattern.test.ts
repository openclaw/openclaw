import { describe, expect, it } from "vitest";
import {
  compileGlobPattern,
  compileGlobPatterns,
  matchesAnyGlobPattern,
} from "./glob-pattern.js";

describe("compileGlobPattern", () => {
  const normalize = (v: string) => v.toLowerCase();

  it("returns 'all' for wildcard", () => {
    expect(compileGlobPattern({ raw: "*", normalize })).toEqual({ kind: "all" });
  });

  it("returns exact match for non-glob", () => {
    expect(compileGlobPattern({ raw: "foo", normalize })).toEqual({ kind: "exact", value: "foo" });
  });

  it("normalizes value before processing", () => {
    const result = compileGlobPattern({ raw: "FOO", normalize });
    expect(result).toEqual({ kind: "exact", value: "foo" });
  });

  it("returns empty exact for empty string", () => {
    expect(compileGlobPattern({ raw: "", normalize })).toEqual({ kind: "exact", value: "" });
  });

  it("compiles glob patterns to regex", () => {
    const result = compileGlobPattern({ raw: "foo*bar", normalize });
    expect(result.kind).toBe("regex");
    expect((result as any).value.test("foobar")).toBe(true);
    expect((result as any).value.test("fooXYZbar")).toBe(true);
    expect((result as any).value.test("foobaz")).toBe(false);
  });
});

describe("compileGlobPatterns", () => {
  const normalize = (v: string) => v.toLowerCase();

  it("returns empty array for undefined", () => {
    expect(compileGlobPatterns({ raw: undefined, normalize })).toEqual([]);
  });

  it("returns empty array for non-array", () => {
    expect(compileGlobPatterns({ raw: "foo" as any, normalize })).toEqual([]);
  });

  it("filters out empty exact patterns", () => {
    const result = compileGlobPatterns({ raw: ["", "foo", ""], normalize });
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ kind: "exact", value: "foo" });
  });
});

describe("matchesAnyGlobPattern", () => {
  it("returns true for 'all' pattern", () => {
    const patterns = [{ kind: "all" as const }];
    expect(matchesAnyGlobPattern("anything", patterns)).toBe(true);
  });

  it("matches exact patterns", () => {
    const patterns = [{ kind: "exact" as const, value: "foo" }];
    expect(matchesAnyGlobPattern("foo", patterns)).toBe(true);
    expect(matchesAnyGlobPattern("bar", patterns)).toBe(false);
  });

  it("matches regex patterns", () => {
    const patterns = [{ kind: "regex" as const, value: /^foo.*$/ }];
    expect(matchesAnyGlobPattern("foobar", patterns)).toBe(true);
    expect(matchesAnyGlobPattern("bar", patterns)).toBe(false);
  });

  it("returns false for empty patterns", () => {
    expect(matchesAnyGlobPattern("foo", [])).toBe(false);
  });
});
