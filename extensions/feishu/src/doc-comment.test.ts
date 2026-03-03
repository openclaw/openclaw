import { describe, it, expect } from "vitest";
import { parseDocUrl, extractDocUrls } from "./doc-comment.js";

describe("parseDocUrl", () => {
  it("should parse docx URL", () => {
    const result = parseDocUrl("https://example.feishu.cn/docx/ABC123");
    expect(result).toEqual({
      fileToken: "ABC123",
      fileType: "docx",
      commentId: undefined,
      replyId: undefined,
    });
  });

  it("should parse docs URL", () => {
    const result = parseDocUrl("https://example.feishu.cn/docs/XYZ789");
    expect(result).toEqual({
      fileToken: "XYZ789",
      fileType: "doc",
      commentId: undefined,
      replyId: undefined,
    });
  });

  it("should parse sheets URL", () => {
    const result = parseDocUrl("https://example.feishu.cn/sheets/Sheet123");
    expect(result).toEqual({
      fileToken: "Sheet123",
      fileType: "sheet",
      commentId: undefined,
      replyId: undefined,
    });
  });

  it("should parse bitable URL", () => {
    const result = parseDocUrl("https://example.feishu.cn/base/Base456");
    expect(result).toEqual({
      fileToken: "Base456",
      fileType: "bitable",
      commentId: undefined,
      replyId: undefined,
    });
  });

  it("should parse URL with comment anchor", () => {
    const result = parseDocUrl("https://example.feishu.cn/docx/ABC123#comment-CMT001");
    expect(result).toEqual({
      fileToken: "ABC123",
      fileType: "docx",
      commentId: "CMT001",
      replyId: undefined,
    });
  });

  it("should parse URL with comment and reply anchor", () => {
    const result = parseDocUrl("https://example.feishu.cn/docx/ABC123#comment-CMT001-reply-RPL001");
    expect(result).toEqual({
      fileToken: "ABC123",
      fileType: "docx",
      commentId: "CMT001",
      replyId: "RPL001",
    });
  });

  it("should return null for invalid URL", () => {
    expect(parseDocUrl("https://example.com/not-feishu")).toBeNull();
    expect(parseDocUrl("not-a-url")).toBeNull();
    expect(parseDocUrl("https://example.feishu.cn/unknown/ABC")).toBeNull();
  });

  it("should handle Lark international domain (larksuite.com)", () => {
    const result = parseDocUrl("https://example.larksuite.com/docx/ABC123");
    expect(result).toEqual({
      fileToken: "ABC123",
      fileType: "docx",
      commentId: undefined,
      replyId: undefined,
    });
  });

  it("should handle Lark international domain (larkoffice.com)", () => {
    const result = parseDocUrl("https://example.larkoffice.com/docx/ABC123");
    expect(result).toEqual({
      fileToken: "ABC123",
      fileType: "docx",
      commentId: undefined,
      replyId: undefined,
    });
  });

  it("should handle bare domain without subdomain", () => {
    expect(parseDocUrl("https://feishu.cn/docx/ABC123")).toEqual({
      fileToken: "ABC123",
      fileType: "docx",
      commentId: undefined,
      replyId: undefined,
    });
    expect(parseDocUrl("https://larksuite.com/docx/ABC123")).toEqual({
      fileToken: "ABC123",
      fileType: "docx",
      commentId: undefined,
      replyId: undefined,
    });
  });

  it("should reject non-Feishu domain with valid doc path", () => {
    // Security: must reject URLs from arbitrary domains even if path looks valid
    expect(parseDocUrl("https://evil.com/docx/ABC123")).toBeNull();
    expect(parseDocUrl("https://fake-feishu.cn/docx/ABC123")).toBeNull();
    expect(parseDocUrl("https://feishu.cn.evil.com/docx/ABC123")).toBeNull();
    expect(parseDocUrl("https://not-larksuite.com/docx/ABC123")).toBeNull();
  });
});

describe("extractDocUrls", () => {
  it("should extract single URL from text", () => {
    const text = "请查看这个文档 https://example.feishu.cn/docx/ABC123 谢谢";
    const results = extractDocUrls(text);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      fileToken: "ABC123",
      fileType: "docx",
      commentId: undefined,
      replyId: undefined,
    });
  });

  it("should extract multiple URLs from text", () => {
    const text = `
      文档1: https://example.feishu.cn/docx/DOC001
      文档2: https://example.feishu.cn/sheets/SHEET001#comment-CMT001
    `;
    const results = extractDocUrls(text);
    expect(results).toHaveLength(2);
    expect(results[0].fileToken).toBe("DOC001");
    expect(results[1].fileToken).toBe("SHEET001");
    expect(results[1].commentId).toBe("CMT001");
  });

  it("should return empty array for text without URLs", () => {
    const results = extractDocUrls("普通文本，没有链接");
    expect(results).toHaveLength(0);
  });

  it("should ignore non-document Feishu URLs", () => {
    const text = "https://example.feishu.cn/messenger/chat/123";
    const results = extractDocUrls(text);
    expect(results).toHaveLength(0);
  });
});
