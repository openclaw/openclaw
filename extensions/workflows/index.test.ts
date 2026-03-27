import { describe, expect, it } from "vitest";
import { __testing } from "./index.js";

const { escapeShellArg } = __testing;

describe("escapeShellArg", () => {
  it("passes through plain text", () => {
    expect(escapeShellArg("hello world")).toBe("hello world");
  });

  it("escapes double quotes", () => {
    expect(escapeShellArg('say "hello"')).toBe('say \\"hello\\"');
  });

  it("escapes backslashes", () => {
    expect(escapeShellArg("path\\to\\file")).toBe("path\\\\to\\\\file");
  });

  it("preserves single quotes (safe inside double-quoted shell strings)", () => {
    expect(escapeShellArg("check today's ads")).toBe("check today's ads");
  });

  it("handles combined special characters", () => {
    expect(escapeShellArg("let's say \"it's fine\"")).toBe("let's say \\\"it's fine\\\"");
  });
});

describe("workflow inputs shell safety", () => {
  it("inputs with apostrophes produce valid double-quoted shell arg", () => {
    const inputs = JSON.stringify({ request: "check today's Shopee ads performance" });
    const escaped = escapeShellArg(inputs);
    // The escaped string should be safe inside double quotes
    // Single quotes should pass through untouched
    expect(escaped).toContain("today's");
    // Double quotes from JSON should be escaped
    expect(escaped).toContain('\\"request\\"');
    // The full string should be reconstructable
    const reconstructed = escaped.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    expect(JSON.parse(reconstructed)).toEqual({ request: "check today's Shopee ads performance" });
  });

  it("inputs with nested quotes and backslashes survive round-trip", () => {
    const inputs = JSON.stringify({
      request: 'say "it\'s \\ fine"',
    });
    const escaped = escapeShellArg(inputs);
    const reconstructed = escaped.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    expect(JSON.parse(reconstructed)).toEqual({ request: 'say "it\'s \\ fine"' });
  });
});
