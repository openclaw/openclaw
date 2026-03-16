import { describe, expect, it } from "vitest";
import { decodeFeishuFilename } from "./bot.js";

describe("decodeFeishuFilename", () => {
  it("returns empty string for undefined", () => {
    expect(decodeFeishuFilename(undefined)).toBe("");
  });

  it("returns empty string for empty string", () => {
    expect(decodeFeishuFilename("")).toBe("");
  });

  it("decodes URL-encoded Chinese filename", () => {
    expect(decodeFeishuFilename("%E6%B5%8B%E8%AF%95.pdf")).toBe("测试.pdf");
  });

  it("decodes URL-encoded English filename", () => {
    expect(decodeFeishuFilename("test%20file.pdf")).toBe("test file.pdf");
  });

  it("returns original string when decoding fails", () => {
    expect(decodeFeishuFilename("invalid%")).toBe("invalid%");
  });

  it("preserves literal filenames without percent-encoding", () => {
    // Filenames that don't look URL-encoded should be preserved
    expect(decodeFeishuFilename("test file.pdf")).toBe("test file.pdf");
    expect(decodeFeishuFilename("plain.txt")).toBe("plain.txt");
    // Literal % not followed by hex should be preserved
    expect(decodeFeishuFilename("50% off.txt")).toBe("50% off.txt");
  });

  it("handles filenames without encoding", () => {
    expect(decodeFeishuFilename("plain.txt")).toBe("plain.txt");
  });

  it("handles special characters", () => {
    expect(decodeFeishuFilename("file%20%28%29.pdf")).toBe("file ().pdf");
  });
});
