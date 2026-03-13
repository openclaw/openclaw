import { describe, expect, it } from "vitest";
import { normalizeFeishuExternalKey } from "./external-keys.js";

describe("normalizeFeishuExternalKey", () => {
  it("accepts a normal feishu key and trims surrounding spaces", () => {
    expect(normalizeFeishuExternalKey("  img_v3_01abcDEF123  ")).toBe("img_v3_01abcDEF123");
  });

  it("rejects traversal and path separator patterns", () => {
    expect(normalizeFeishuExternalKey("../etc/passwd")).toBeUndefined();
    expect(normalizeFeishuExternalKey("a/../../b")).toBeUndefined();
    expect(normalizeFeishuExternalKey("a\\..\\b")).toBeUndefined();
  });

  it("rejects empty, non-string, and control-char values", () => {
    expect(normalizeFeishuExternalKey("   ")).toBeUndefined();
    expect(normalizeFeishuExternalKey(123)).toBeUndefined();
    expect(normalizeFeishuExternalKey("abc\u0000def")).toBeUndefined();
  });

  it("accepts keys containing '..' as substring (regression test for #42257)", () => {
    // Feishu image/file keys may contain ".." as a valid substring
    // These should not be flagged as path traversal attacks
    expect(normalizeFeishuExternalKey("img_v2_test..key")).toBe("img_v2_test..key");
    expect(normalizeFeishuExternalKey("img_v2_a..b..c")).toBe("img_v2_a..b..c");
    expect(normalizeFeishuExternalKey("key..value..end")).toBe("key..value..end");
    expect(normalizeFeishuExternalKey("file_v2_042a8b78..5f17")).toBe("file_v2_042a8b78..5f17");
  });

  it("still rejects actual path traversal attacks", () => {
    // True path traversal patterns should still be blocked
    expect(normalizeFeishuExternalKey("../etc/passwd")).toBeUndefined();
    expect(normalizeFeishuExternalKey("a/../../b")).toBeUndefined();
    expect(normalizeFeishuExternalKey("a\\..\\b")).toBeUndefined();
    expect(normalizeFeishuExternalKey("./test")).toBeUndefined();
    expect(normalizeFeishuExternalKey("a./b")).toBe("a./b"); // "." in middle is OK
    expect(normalizeFeishuExternalKey("a../b")).toBe("a../b"); // ".." in middle without separators is OK
  });
});
