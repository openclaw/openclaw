import { describe, expect, it } from "vitest";
import { mergeStreamingText, resolveStreamingCardSendMode } from "./streaming-card.js";
describe("mergeStreamingText", () => {
  it("prefers the latest full text when it already includes prior text", () => {
    expect(mergeStreamingText("hello", "hello world")).toBe("hello world");
  });
  it("keeps previous text when the next partial is empty or redundant", () => {
    expect(mergeStreamingText("hello", "")).toBe("hello");
    expect(mergeStreamingText("hello world", "hello")).toBe("hello world");
  });
  it("appends fragmented chunks without injecting newlines", () => {
    expect(mergeStreamingText("hello wor", "ld")).toBe("hello world");
    expect(mergeStreamingText("line1", "line2")).toBe("line1line2");
  });
  it("merges overlap between adjacent partial snapshots", () => {
    expect(mergeStreamingText("\u597D\u7684\uFF0C\u8BA9\u6211", "\u8BA9\u6211\u518D\u8BFB\u53D6\u4E00\u904D")).toBe("\u597D\u7684\uFF0C\u8BA9\u6211\u518D\u8BFB\u53D6\u4E00\u904D");
    expect(mergeStreamingText("revision_id: 552", "2\uFF0C\u4E00\u70B9\u53D8\u5316\u90FD\u6CA1\u6709")).toBe(
      "revision_id: 552\uFF0C\u4E00\u70B9\u53D8\u5316\u90FD\u6CA1\u6709"
    );
    expect(mergeStreamingText("abc", "cabc")).toBe("cabc");
  });
});
describe("resolveStreamingCardSendMode", () => {
  it("prefers message.reply when reply target and root id both exist", () => {
    expect(
      resolveStreamingCardSendMode({
        replyToMessageId: "om_parent",
        rootId: "om_topic_root"
      })
    ).toBe("reply");
  });
  it("falls back to root create when reply target is absent", () => {
    expect(
      resolveStreamingCardSendMode({
        rootId: "om_topic_root"
      })
    ).toBe("root_create");
  });
  it("uses create mode when no reply routing fields are provided", () => {
    expect(resolveStreamingCardSendMode()).toBe("create");
    expect(
      resolveStreamingCardSendMode({
        replyInThread: true
      })
    ).toBe("create");
  });
});
