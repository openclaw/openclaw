import { describe, expect, it } from "vitest";
import { decodeFeishuFilename } from "./bot.js";

describe("decodeFeishuFilename", () => {
  it("returns empty string for undefined", () => {
    expect(decodeFeishuFilename(undefined)).toBe("");
  });

  it("returns empty string for empty string", () => {
    expect(decodeFeishuFilename("")).toBe("");
  });

  it("preserves plain filenames", () => {
    // Plain filenames should be returned as-is
    expect(decodeFeishuFilename("report%202026.pdf")).toBe("report%202026.pdf");
    expect(decodeFeishuFilename("报告 v1.pdf")).toBe("报告 v1.pdf");
    expect(decodeFeishuFilename("50%off.txt")).toBe("50%off.txt");
    expect(decodeFeishuFilename("plain.txt")).toBe("plain.txt");
    expect(decodeFeishuFilename("file with spaces.pdf")).toBe("file with spaces.pdf");
  });

  it("decodes RFC 5987 format", () => {
    // RFC 5987 format should be decoded
    expect(decodeFeishuFilename("filename*=UTF-8''%E6%B5%8B%E8%AF%95.pdf")).toBe("测试.pdf");
  });

  it("decodes RFC 5987 with language tag", () => {
    expect(decodeFeishuFilename("filename*=UTF-8'zh-CN'%E6%B5%8B%E8%AF%95.pdf")).toBe("测试.pdf");
  });
});
