import { describe, expect, it } from "vitest";
import {
  matchesMcpToolFilterPattern,
  mcpToolFilterExcludesAll,
} from "./agent-bundle-mcp-filter.js";

describe("matchesMcpToolFilterPattern", () => {
  it.each([
    ["", "tool", false],
    ["search_docs", "search_docs", true],
    ["search_docs", "read_docs", false],
    ["*_docs", "search_docs", true],
    ["resources_*", "resources_read", true],
    ["a**b***c", "axbyc", true],
    ["a*b*c", "acb", false],
  ])("matches %j against %j", (pattern, value, expected) => {
    expect(matchesMcpToolFilterPattern(pattern, value)).toBe(expected);
  });

  it("rejects adversarial separated wildcards without regex backtracking", () => {
    const pattern = `${"*a".repeat(128)}*b`;
    const value = `${"a".repeat(10_000)}c`;
    expect(matchesMcpToolFilterPattern(pattern, value)).toBe(false);
  });
});

describe("mcpToolFilterExcludesAll", () => {
  it.each([
    ["*", true],
    [" ** ", true],
    ["", false],
    ["read_docs", false],
    ["*docs*", false],
  ])("classifies %j", (pattern, expected) => {
    expect(mcpToolFilterExcludesAll({ exclude: [pattern] })).toBe(expected);
  });

  it("recognizes only a universal exclude in a raw tool filter", () => {
    expect(mcpToolFilterExcludesAll({ exclude: ["read_docs", "*"] })).toBe(true);
    expect(mcpToolFilterExcludesAll({ include: ["*"] })).toBe(false);
    expect(mcpToolFilterExcludesAll({ exclude: ["*docs*"] })).toBe(false);
    expect(mcpToolFilterExcludesAll({ exclude: [7] })).toBe(false);
    expect(mcpToolFilterExcludesAll(null)).toBe(false);
  });
});
