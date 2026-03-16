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

  it("preserves literal percent signs in filenames", () => {
    expect(decodeFeishuFilename("report%202026.pdf")).toBe("report%202026.pdf");
    expect(decodeFeishuFilename("50%off.txt")).toBe("50%off.txt");
  });

  it("handles filenames without encoding", () => {
    expect(decodeFeishuFilename("plain.txt")).toBe("plain.txt");
  });

  it("handles special characters", () => {
    expect(decodeFeishuFilename("file with spaces.pdf")).toBe("file with spaces.pdf");
  });

  it("decodes RFC 5987 format", () => {
    expect(decodeFeishuFilename("filename*=UTF-8''%E6%B5%8B%E8%AF%95.pdf")).toBe("测试.pdf");
  });
});
