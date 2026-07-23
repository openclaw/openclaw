// Qqbot tests cover media tags plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeMediaTags } from "./media-tags.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

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

  it("does not match invalid input", () => {
    const input = "no tag here";
    expect(normalizeMediaTags(input)).toBe(input);
  });

  it("falls back to USERPROFILE when HOME is blank", () => {
    vi.stubEnv("HOME", "");
    vi.stubEnv("USERPROFILE", String.raw`C:\Users\operator`);

    expect(normalizeMediaTags("<qqimg>~/photo.png</qqimg>")).toBe(
      String.raw`<qqimg>C:\Users\operator/photo.png</qqimg>`,
    );
  });
});
