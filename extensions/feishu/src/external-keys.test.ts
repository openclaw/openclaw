import { describe, expect, it } from "vitest";
import { normalizeFeishuExternalKey, stripFeishuReactionSuffix } from "./external-keys.js";

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
});

describe("stripFeishuReactionSuffix", () => {
  it("returns plain message IDs unchanged", () => {
    expect(stripFeishuReactionSuffix("om_abc123")).toBe("om_abc123");
  });

  it("strips :reaction: suffix from synthetic reaction IDs", () => {
    expect(
      stripFeishuReactionSuffix("om_abc123:reaction:THUMBSUP:550dd4ec-46af-41c9-affc-a68cd11a5e49"),
    ).toBe("om_abc123");
  });

  it("strips other emoji reaction suffixes", () => {
    expect(
      stripFeishuReactionSuffix("om_xyz789:reaction:HEART:12345678-1234-1234-1234-123456789abc"),
    ).toBe("om_xyz789");
  });

  it("handles edge case with :reaction: in the middle of a longer ID", () => {
    expect(stripFeishuReactionSuffix("om_x100b55b7:reaction:LAUGH:uuid-here")).toBe("om_x100b55b7");
  });
});
