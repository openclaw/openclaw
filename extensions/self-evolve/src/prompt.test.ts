import { describe, expect, it } from "vitest";
import { sanitizeMemoryText, stripConversationMetadata } from "./prompt.js";

describe("stripConversationMetadata", () => {
  it("removes conversation metadata block and keeps user content", () => {
    const input = [
      "Conversation info (untrusted metadata):",
      "```json",
      '{"message_id":"123","sender":"u1"}',
      "```",
      "",
      "帮我看看 /data 目录下有哪些文件",
    ].join("\n");
    expect(stripConversationMetadata(input)).toBe("帮我看看 /data 目录下有哪些文件");
  });

  it("returns original text when no metadata prefix exists", () => {
    const input = "如何查看 openclaw 调用 tools 的日志？";
    expect(stripConversationMetadata(input)).toBe(input);
  });

  it("removes sender untrusted metadata block", () => {
    const input = [
      "Sender (untrusted metadata):",
      "```json",
      '{"label":"Longman","id":"537121267"}',
      "```",
      "",
      "帮我看看当前机器磁盘空间还有多少",
    ].join("\n");
    expect(stripConversationMetadata(input)).toBe("帮我看看当前机器磁盘空间还有多少");
  });

  it("removes metadata when prefixed inside intent/user_feedback lines", () => {
    const input = [
      "intent: Sender (untrusted metadata):",
      "```json",
      '{\"label\":\"Longman\",\"id\":\"537121267\"}',
      "```",
      "",
      "帮我看看/home目录下有哪些文件？",
      "user_feedback: Sender (untrusted metadata):",
      "```json",
      '{\"label\":\"Longman\",\"id\":\"537121267\"}',
      "```",
      "",
      "很好",
    ].join("\n");
    expect(stripConversationMetadata(input)).toBe(
      ["intent:", "帮我看看/home目录下有哪些文件？", "user_feedback:", "很好"].join("\n"),
    );
  });

  it("sanitizes message id and sender id leakage for memory fields", () => {
    const input = [
      "[message_id: om_x100b559d255a5904c2ef5b224426c1b]",
      "ou_41b427ee3d1ca8304e83f6540c04a3cb: 你帮我看看/data 目录下有什么",
      "",
      "user_feedback: [message_id: om_x100b559d3ea5d444c117283ea62a031]",
      "ou_41b427ee3d1ca8304e83f6540c04a3cb: 赞",
    ].join("\n");
    expect(sanitizeMemoryText(input)).toBe(
      ["你帮我看看/data 目录下有什么", "", "user_feedback:", "赞"].join("\n"),
    );
  });
});
