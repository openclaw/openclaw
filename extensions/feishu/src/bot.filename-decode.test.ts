import { describe, expect, it } from "vitest";
import { decodeFeishuFilename } from "./bot.js";

describe("decodeFeishuFilename", () => {
  it("returns empty string for undefined", () => {
    expect(decodeFeishuFilename(undefined)).toBe("");
  });

  it("returns empty string for empty string", () => {
    expect(decodeFeishuFilename("")).toBe("");
  });

  it("decodes non-ASCII filenames", () => {
    expect(decodeFeishuFilename("%E6%B5%8B%E8%AF%95.pdf")).toBe("测试.pdf");
  });

  it("preserves filenames whose decoded form is all-ASCII or malformed", () => {
    // %20 decodes to a space (all-ASCII), so the original is returned unchanged.
    expect(decodeFeishuFilename("report%202026.pdf")).toBe("report%202026.pdf");
    // %of is malformed percent-encoding; decodeURIComponent throws, so the original is returned.
    expect(decodeFeishuFilename("50%off.txt")).toBe("50%off.txt");
  });

  it("handles filenames without encoding", () => {
    expect(decodeFeishuFilename("plain.txt")).toBe("plain.txt");
  });

  it("handles special characters", () => {
    expect(decodeFeishuFilename("file with spaces.pdf")).toBe("file with spaces.pdf");
  });
});

});

describe("decodeFeishuFilename", () => {
  it("returns empty string for undefined", () => {
    expect(decodeFeishuFilename(undefined)).toBe("");
  });

  it("returns empty string for empty string", () => {
    expect(decodeFeishuFilename("")).toBe("");
  });

  it("decodes non-ASCII filenames", () => {
    expect(decodeFeishuFilename("%E6%B5%8B%E8%AF%95.pdf")).toBe("测试.pdf");
  });

  it("preserves filenames whose decoded form is all-ASCII or malformed", () => {
    // %20 decodes to a space (all-ASCII), so the original is returned unchanged.
    expect(decodeFeishuFilename("report%202026.pdf")).toBe("report%202026.pdf");
    // %of is malformed percent-encoding; decodeURIComponent throws, so the original is returned.
    expect(decodeFeishuFilename("50%off.txt")).toBe("50%off.txt");
  });

  it("handles filenames without encoding", () => {
    expect(decodeFeishuFilename("plain.txt")).toBe("plain.txt");
  });

  it("handles special characters", () => {
    expect(decodeFeishuFilename("file with spaces.pdf")).toBe("file with spaces.pdf");
  });

  it("decodes RFC 5987 format", () => {
    // RFC 5987 format: filename*=UTF-8''encoded
    expect(decodeFeishuFilename("filename*=UTF-8''%E6%B5%8B%E8%AF%95.pdf")).toBe("测试.pdf");
  });
});
