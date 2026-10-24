import { describe, expect, it } from "vitest";
import { createFeishuTestEvent } from "./bot.test-support.js";
import { resolveFeishuMessageDedupeKey } from "./dedupe-key.js";
import type { FeishuMessageEvent } from "./event-types.js";

type Message = FeishuMessageEvent["message"];
const key = (message: Partial<Message> = {}, sender?: string) =>
  resolveFeishuMessageDedupeKey(
    createFeishuTestEvent({
      messageId: "om_first",
      senderOpenId: sender ?? "ou-user",
      message: { create_time: "1710000000000", ...message },
    }),
  );
const richPost = (content: object, message: Partial<Message> = {}) => ({
  message_type: "post",
  content: JSON.stringify({ title: "", ...content }),
  ...message,
});
const post = {
  message_type: "post",
  content: JSON.stringify({ title: "", content: [[{ tag: "text", text: "hello" }]] }),
};

describe("resolveFeishuMessageDedupeKey", () => {
  it.each([
    { name: "text", message: {} },
    { name: "attachment-free post", message: post },
  ])("collapses $name redeliveries but preserves genuine repeat sends", ({ message }) => {
    const first = key(message);
    expect(first).toBeDefined();
    expect(first).not.toBe("om_first");
    expect(key({ ...message, message_id: "om_retry" })).toBe(first);
    expect(key({ ...message, message_id: "om_repeat", create_time: "1710000001000" })).not.toBe(
      first,
    );
  });

  it("does not collide across senders, chats, or content", () => {
    const first = key();
    expect(key({}, "ou-other")).not.toBe(first);
    expect(key({ chat_id: "oc-other" })).not.toBe(first);
    expect(key({ content: JSON.stringify({ text: "bye" }) })).not.toBe(first);
  });

  it.each([
    { name: "text without time", message: { create_time: undefined } },
    { name: "text with malformed time", message: { create_time: "1710000000000ms" } },
    { name: "post without time", message: { ...post, create_time: undefined } },
  ])("uses message_id for $name", ({ message }) => {
    expect(key(message)).toBe("om_first");
  });

  it.each([true, false])("isolates post topics with root_id present=%s", (withRoot) => {
    const topic = {
      ...post,
      chat_id: "oc-topic-group",
      chat_type: "topic_group" as const,
      root_id: withRoot ? "om_root_a" : undefined,
      thread_id: "omt_a",
    };
    const first = key(topic);
    const other = key({
      ...topic,
      message_id: "om_other",
      root_id: withRoot ? "om_root_b" : undefined,
      thread_id: "omt_b",
    });
    expect(first).toBeDefined();
    expect(other).toBeDefined();
    expect(first).not.toBe("om_first");
    expect(other).not.toBe("om_other");
    expect(other).not.toBe(first);
    expect(key({ ...topic, message_id: "om_retry" })).toBe(first);
  });

  it.each([
    [
      "image media keys",
      { message_type: "image", content: '{"image_key":"img_123"}' },
      JSON.stringify(["om_first", "image_key:img_123"]),
    ],
    [
      "grouped rich-post keys with duplicates and invalid-key filtering",
      richPost({
        content: [
          [
            { tag: "media", file_key: "file_first" },
            { tag: "img", image_key: "shared" },
            { tag: "img", image_key: "shared" },
            { tag: "img", image_key: "invalid/key" },
            { tag: "media", file_key: "shared" },
            { tag: "media", file_key: "shared" },
            { tag: "media", file_key: "file_last" },
          ],
        ],
      }),
      JSON.stringify([
        "om_first",
        "image_key:shared",
        "image_key:shared",
        "file_key:file_first",
        "file_key:shared",
        "file_key:shared",
        "file_key:file_last",
      ]),
    ],
    [
      "shipped captioned-post identity with files[]",
      richPost(
        {
          content: [[{ tag: "text", text: "这是账本" }]],
          files: [{ file_key: "file_report", file_name: "report.csv", is_folder: false }],
        },
        { create_time: undefined },
      ),
      "om_first",
    ],
    [
      "inline-media identity despite topic fields and top-level files[]",
      richPost(
        {
          content: [[{ tag: "img", image_key: "img_inline" }]],
          files: [{ file_key: "file_extra", file_name: "extra.csv", is_folder: false }],
        },
        {
          chat_type: "topic_group",
          root_id: "om_root",
          thread_id: "omt_topic",
        },
      ),
      JSON.stringify(["om_first", "image_key:img_inline"]),
    ],
  ] as const)("preserves %s", (_name, message, expected) => {
    expect(key(message)).toBe(expected);
  });
});
