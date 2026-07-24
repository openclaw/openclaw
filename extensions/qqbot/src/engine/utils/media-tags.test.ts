// Qqbot tests cover media tags plugin behavior.
import { describe, expect, it } from "vitest";
import { normalizeMediaTags } from "./media-tags.js";

describe("media-tags with HTML entities", () => {
  it("extracts URL from entity-encoded fuzzy tag", () => {
    const input = "&lt;qqimg&gt;https://example.com/a.png&lt;/qqimg&gt;";
    expect(normalizeMediaTags(input)).toBe("<qqimg>https://example.com/a.png</qqimg>");
  });

  it("extracts URL from mixed entity+plain tag", () => {
    const input = "&lt;qqimg&gt;https://example.com/b.png</qqimg>";
    expect(normalizeMediaTags(input)).toBe("<qqimg>https://example.com/b.png</qqimg>");
  });

  it("extracts file from entity-encoded self-closing tag", () => {
    const input = '&lt;qqmedia file="https://example.com/c.zip" /&gt;';
    expect(normalizeMediaTags(input)).toBe("<qqmedia>https://example.com/c.zip</qqmedia>");
  });

  it("extracts quoted file paths with spaces from self-closing tags", () => {
    const input = '<qqmedia file="C:/tmp/foo bar.png" />';
    expect(normalizeMediaTags(input)).toBe("<qqmedia>C:/tmp/foo bar.png</qqmedia>");
  });

  it("extracts single-quoted file paths with spaces from self-closing tags", () => {
    const input = "<qqmedia file='C:/tmp/foo bar.png' />";
    expect(normalizeMediaTags(input)).toBe("<qqmedia>C:/tmp/foo bar.png</qqmedia>");
  });

  it("keeps unquoted file attributes bounded by whitespace", () => {
    const input = "<qqmedia file=C:/tmp/foo bar.png />";
    expect(normalizeMediaTags(input)).toBe(input);
  });

  it("extracts quoted file paths with spaces after another quoted attribute", () => {
    const input = '<qqmedia alt="upload proof" file="C:/tmp/foo bar.png" />';
    expect(normalizeMediaTags(input)).toBe("<qqmedia>C:/tmp/foo bar.png</qqmedia>");
  });

  it("does not match invalid input", () => {
    const input = "no tag here";
    expect(normalizeMediaTags(input)).toBe(input);
  });
});
