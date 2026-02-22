import { describe, expect, test } from "vitest";
import { extractContent, extractMediaId, extractMsgId } from "./xml-parser.js";

describe("wecom xml-parser", () => {
  test("extractContent is robust to non-string Content", () => {
    const msg: any = { MsgType: "text", Content: { "#text": "hello", "@_foo": "bar" } };
    expect(extractContent(msg)).toBe("hello");
  });

  test("extractContent handles array content", () => {
    const msg: any = { MsgType: "text", Content: ["a", "b"] };
    expect(extractContent(msg)).toBe("a\nb");
  });

  test("extractContent handles file messages", () => {
    const msg: any = { MsgType: "file", MediaId: "MEDIA123" };
    expect(extractContent(msg)).toBe("[文件消息]");
  });

  test("extractMediaId handles object MediaId", () => {
    const msg: any = { MediaId: { "#text": "MEDIA123", "@_foo": "bar" } };
    expect(extractMediaId(msg)).toBe("MEDIA123");
  });

  test("extractMsgId handles number MsgId", () => {
    const msg: any = { MsgId: 123456789 };
    expect(extractMsgId(msg)).toBe("123456789");
  });
});
