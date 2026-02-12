import { describe, it, expect } from "vitest";
import { extractThinkDirective, extractThinkOnceDirective } from "./think-directive.js";

describe("extractThinkDirective", () => {
  it("parses /think with level", () => {
    const res = extractThinkDirective("/think low hello");
    expect(res.hasDirective).toBe(true);
    expect(res.thinkLevel).toBe("low");
    expect(res.cleaned).toBe("hello");
  });

  it("parses inline /think: with level", () => {
    const res = extractThinkDirective("hello /think: high world");
    expect(res.hasDirective).toBe(true);
    expect(res.thinkLevel).toBe("high");
    expect(res.cleaned).toBe("hello world");
  });

  it("supports /t on alias", () => {
    const res = extractThinkDirective("/t on hello");
    expect(res.thinkLevel).toBe("high");
    expect(res.cleaned).toBe("hello");
  });

  it("does not match /t! in persistent parser", () => {
    const res = extractThinkDirective("/t! on hello");
    expect(res.hasDirective).toBe(false);
    expect(res.cleaned).toBe("/t! on hello");
  });
});

describe("extractThinkOnceDirective", () => {
  it("parses /t! on", () => {
    const res = extractThinkOnceDirective("/t! on hello");
    expect(res.hasDirective).toBe(true);
    expect(res.thinkLevel).toBe("high");
    expect(res.cleaned).toBe("hello");
  });

  it("parses /think! minimal", () => {
    const res = extractThinkOnceDirective("/think! minimal hello");
    expect(res.hasDirective).toBe(true);
    expect(res.thinkLevel).toBe("minimal");
    expect(res.cleaned).toBe("hello");
  });
});
