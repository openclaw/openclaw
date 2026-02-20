import { describe, expect, it } from "vitest";
import { parseArgs } from "./parse-args.js";

describe("parseArgs", () => {
  it("returns defaults for empty string", () => {
    const result = parseArgs("");
    expect(result).toEqual({ period: "1d", filters: {} });
  });

  it("returns defaults for whitespace-only input", () => {
    const result = parseArgs("   ");
    expect(result).toEqual({ period: "1d", filters: {} });
  });

  it("parses period-only argument (days)", () => {
    expect(parseArgs("7d")).toEqual({ period: "7d", filters: {} });
  });

  it("parses period-only argument (hours)", () => {
    expect(parseArgs("3h")).toEqual({ period: "3h", filters: {} });
  });

  it("parses period-only argument (weeks)", () => {
    expect(parseArgs("2w")).toEqual({ period: "2w", filters: {} });
  });

  it("parses period-only argument (months)", () => {
    expect(parseArgs("1m")).toEqual({ period: "1m", filters: {} });
  });

  it("parses from filter with period", () => {
    const result = parseArgs("from:user@company.com 7d");
    expect(result).toEqual({
      period: "7d",
      filters: { from: "user@company.com" },
    });
  });

  it("parses from filter without period (defaults to 1d)", () => {
    const result = parseArgs("from:user@company.com");
    expect(result).toEqual({
      period: "1d",
      filters: { from: "user@company.com" },
    });
  });

  it("parses to filter", () => {
    const result = parseArgs("to:team@company.com 3d");
    expect(result).toEqual({
      period: "3d",
      filters: { to: "team@company.com" },
    });
  });

  it("parses urgent flag", () => {
    const result = parseArgs("urgent");
    expect(result).toEqual({
      period: "1d",
      filters: { urgent: true },
    });
  });

  it("parses urgent flag with period", () => {
    const result = parseArgs("urgent 3d");
    expect(result).toEqual({
      period: "3d",
      filters: { urgent: true },
    });
  });

  it("parses unread flag", () => {
    const result = parseArgs("unread 2d");
    expect(result).toEqual({
      period: "2d",
      filters: { unread: true },
    });
  });

  it("parses multiple filters combined", () => {
    const result = parseArgs("from:boss@work.com urgent 2d");
    expect(result).toEqual({
      period: "2d",
      filters: { from: "boss@work.com", urgent: true },
    });
  });

  it("parses free text filter with period", () => {
    const result = parseArgs("project-alpha 7d");
    expect(result).toEqual({
      period: "7d",
      filters: { freeText: "project-alpha" },
    });
  });

  it("parses multiple free text tokens", () => {
    const result = parseArgs("quarterly report 7d");
    expect(result).toEqual({
      period: "7d",
      filters: { freeText: "quarterly report" },
    });
  });

  it("parses all filter types together", () => {
    const result = parseArgs("from:ceo@company.com urgent project-update 3d");
    expect(result).toEqual({
      period: "3d",
      filters: {
        from: "ceo@company.com",
        urgent: true,
        freeText: "project-update",
      },
    });
  });

  it("handles case-insensitive filter keywords", () => {
    const result = parseArgs("FROM:User@Test.com URGENT 5d");
    expect(result).toEqual({
      period: "5d",
      filters: { from: "User@Test.com", urgent: true },
    });
  });

  it("treats non-matching last token as free text", () => {
    // "abc" does not match period regex
    const result = parseArgs("abc");
    expect(result).toEqual({
      period: "1d",
      filters: { freeText: "abc" },
    });
  });

  it("does not match invalid period format", () => {
    // "0d" is technically valid (matches regex), would be 0 days
    const result = parseArgs("100x");
    expect(result).toEqual({
      period: "1d",
      filters: { freeText: "100x" },
    });
  });

  it("handles large period numbers", () => {
    expect(parseArgs("30d")).toEqual({ period: "30d", filters: {} });
  });
});
