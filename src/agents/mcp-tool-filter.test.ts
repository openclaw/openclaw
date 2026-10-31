import { describe, expect, it } from "vitest";
import { createMcpToolFilter, normalizeMcpToolFilter } from "./mcp-tool-filter.js";

describe("createMcpToolFilter", () => {
  it.each([
    ["", "tool", false],
    ["search_docs", "search_docs", true],
    ["search_docs", "read_docs", false],
    ["*_docs", "search_docs", true],
    ["resources_*", "resources_read", true],
    ["a**b***c", "axbyc", true],
    ["a*b*c", "acb", false],
    ["DOC_*", "DOC_read", true],
    ["DOC_*", "doc_read", false],
  ])("matches %j against %j", (pattern, value, expected) => {
    expect(createMcpToolFilter({ include: [pattern] })(value)).toBe(expected);
  });

  it("rejects adversarial separated wildcards without regex backtracking", () => {
    const pattern = `${"*a".repeat(128)}*b`;
    const value = `${"a".repeat(10_000)}c`;
    expect(createMcpToolFilter({ include: [pattern] })(value)).toBe(false);
  });

  it.each([
    [undefined, undefined],
    ["malformed", undefined],
    [{ include: "search_*", exclude: 42 }, undefined],
    [{ include: [] }, undefined],
    [{ include: [false, "search_*", null] }, { include: ["search_*"] }],
    [{ include: [false, null] }, undefined],
    [{ exclude: [false, "search_*", null] }, { exclude: ["search_*"] }],
    [
      { include: [" *_docs "], exclude: ["admin_*"] },
      { include: [" *_docs "], exclude: ["admin_*"] },
    ],
  ])("normalizes filter %j", (raw, expected) => {
    expect(normalizeMcpToolFilter(raw)).toEqual(expected);
  });

  it("requires an include match and lets exclude win", () => {
    const allowed = createMcpToolFilter({ include: ["*_docs"], exclude: ["search_*"] });
    expect(allowed("read_docs")).toBe(true);
    expect(allowed("search_docs")).toBe(false);
    expect(allowed("read_file")).toBe(false);
  });

  // Probe lists read.page and read-page both under demo__read-page, and lists
  // a, A, A-2 as demo__a, demo__A-2, demo__A-2-2.
  it.each([
    [{ include: ["demo__list_tables"] }, ["list_tables"]],
    [{ include: ["demo__query"] }, ["demo__query"]],
    [{ include: ["demo__demo__query"] }, ["demo__query"]],
    [{ include: ["demo__*"] }, ["demo__query"]],
    [{ include: ["demo__read-page", "demo__A-2"] }, []],
    [
      { exclude: ["demo__list_tables", "demo__read-page", "demo__A-2"] },
      ["query", "demo__query", "a"],
    ],
  ])("resolves probe names in %j to their raw tools", (filter, expected) => {
    const toolNames = "query list_tables demo__query read.page read-page a A A-2".split(" ");
    const allowed = createMcpToolFilter(filter, { safeServerName: "demo", toolNames });
    expect(toolNames.filter(allowed)).toEqual(expected);
  });
});
