import { describe, expect, it } from "vitest";
import { normalizeToolParams, stripXmlArgValueSuffix } from "./pi-tools.params.js";

describe("stripXmlArgValueSuffix", () => {
  it("strips </arg_value>> suffix", () => {
    expect(stripXmlArgValueSuffix('echo "test</arg_value>>')).toBe('echo "test');
  });

  it("strips </arg_value> suffix (single >)", () => {
    expect(stripXmlArgValueSuffix('echo "test</arg_value>')).toBe('echo "test');
  });

  it("strips </arg_value>>> suffix (triple >)", () => {
    expect(stripXmlArgValueSuffix('echo "test</arg_value>>>')).toBe('echo "test');
  });

  it("leaves clean strings unchanged", () => {
    expect(stripXmlArgValueSuffix('echo "hello world"')).toBe('echo "hello world"');
  });

  it("leaves empty string unchanged", () => {
    expect(stripXmlArgValueSuffix("")).toBe("");
  });

  it("handles file paths with suffix", () => {
    expect(stripXmlArgValueSuffix("/home/user/test.txt</arg_value>>")).toBe("/home/user/test.txt");
  });
});

describe("normalizeToolParams strips XML arg_value suffixes", () => {
  it("strips </arg_value>> from command param", () => {
    const result = normalizeToolParams({ command: 'echo "test</arg_value>>' });
    expect(result?.command).toBe('echo "test');
  });

  it("strips </arg_value>> from path param", () => {
    const result = normalizeToolParams({ path: "/home/user/test.txt</arg_value>>" });
    expect(result?.path).toBe("/home/user/test.txt");
  });

  it("strips </arg_value>> from file_path param (normalizes to path)", () => {
    const result = normalizeToolParams({ file_path: "/home/user/test.txt</arg_value>>" });
    expect(result?.path).toBe("/home/user/test.txt");
  });

  it("leaves clean params unchanged", () => {
    const result = normalizeToolParams({ command: "ls -la", path: "/tmp" });
    expect(result?.command).toBe("ls -la");
    expect(result?.path).toBe("/tmp");
  });

  it("does not affect non-string values", () => {
    const result = normalizeToolParams({ timeout: 5000, background: true });
    expect(result?.timeout).toBe(5000);
    expect(result?.background).toBe(true);
  });
});
