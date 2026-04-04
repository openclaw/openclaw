import { describe, expect, it } from "vitest";
import { sanitizeForConsole } from "./console-sanitize.js";

describe("sanitizeForConsole", () => {
  it("returns undefined for empty string", () => {
    expect(sanitizeForConsole("")).toBeUndefined();
    expect(sanitizeForConsole("   ")).toBeUndefined();
    expect(sanitizeForConsole(undefined)).toBeUndefined();
  });

  it("trims whitespace", () => {
    expect(sanitizeForConsole("  hello  ")).toBe("hello");
  });

  it("removes control characters", () => {
    expect(sanitizeForConsole("hello\x00world")).toBe("helloworld");
    expect(sanitizeForConsole("a\x07b\x08c")).toBe("abc");
  });

  it("collapses newlines and tabs to spaces", () => {
    expect(sanitizeForConsole("hello\nworld")).toBe("hello world");
    expect(sanitizeForConsole("a\t\tb")).toBe("a b");
    expect(sanitizeForConsole("foo\r\nbar")).toBe("foo bar");
  });

  it("collapses multiple spaces", () => {
    expect(sanitizeForConsole("hello    world")).toBe("hello world");
  });

  it("truncates long strings with ellipsis", () => {
    const long = "a".repeat(300);
    const result = sanitizeForConsole(long, 200);
    expect(result?.length).toBe(201); // 200 chars + ellipsis
    expect(result?.endsWith("…")).toBe(true);
  });

  it("respects custom maxChars", () => {
    expect(sanitizeForConsole("hello world", 5)).toBe("hello…");
    expect(sanitizeForConsole("hi", 10)).toBe("hi");
  });

  it("preserves printable characters", () => {
    expect(sanitizeForConsole("Hello, World!")).toBe("Hello, World!");
    expect(sanitizeForConsole("emoji: 🐱")).toBe("emoji: 🐱");
  });
});
