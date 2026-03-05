import { describe, expect, it } from "vitest";
import { mergeStreamingText } from "./streaming-card.js";

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

  it("replaces bootstrap placeholders when first real content arrives", () => {
    expect(mergeStreamingText("⏳ Thinking...", "hello")).toBe("hello");
    expect(mergeStreamingText("⏳ 正在连接模型并等待首段输出…", "你好")).toBe("你好");
  });

  it("ignores bootstrap placeholder updates after real content is present", () => {
    expect(mergeStreamingText("hello", "⏳ Thinking...")).toBe("hello");
    expect(mergeStreamingText("你好", "⏳ 正在连接模型并等待首段输出…")).toBe("你好");
  });

  it("strips bootstrap placeholder prefixes from first real streaming chunk", () => {
    expect(mergeStreamingText("⏳ Thinking...", "⏳ Thinking...Hey")).toBe("Hey");
    expect(
      mergeStreamingText("⏳ 正在连接模型并等待首段输出…", "⏳ 正在连接模型并等待首段输出…你好"),
    ).toBe("你好");
  });

  it("does not duplicate the first token after placeholder bootstrap", () => {
    const firstChunk = mergeStreamingText("⏳ Thinking...", "⏳ Thinking...Hey");
    expect(mergeStreamingText(firstChunk, "Hey")).toBe("Hey");
  });
});
