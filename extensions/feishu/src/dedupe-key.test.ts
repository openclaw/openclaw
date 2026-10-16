import { describe, expect, it } from "vitest";
import { resolveFeishuMessageDedupeKey } from "./dedupe-key.js";
import type { FeishuMessageEvent } from "./event-types.js";

type Message = FeishuMessageEvent["message"];
function event(message: Partial<Message> = {}, sender = "ou-user"): FeishuMessageEvent {
  return {
    sender: { sender_id: { open_id: sender } },
    message: {
      message_id: "om_first",
      chat_id: "oc-dm",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: "hello" }),
      create_time: "1710000000000",
      ...message,
    },
  };
}
const key = resolveFeishuMessageDedupeKey;
const post = {
  message_type: "post",
  content: JSON.stringify({ title: "", content: [[{ tag: "text", text: "hello" }]] }),
};

describe("resolveFeishuMessageDedupeKey", () => {
  it.each([
    { name: "text", message: {} },
    { name: "attachment-free post", message: post },
  ])("collapses $name redeliveries but preserves genuine repeat sends", ({ message }) => {
    const first = key(event(message));
    expect(first).toBeDefined();
    expect(first).not.toBe("om_first");
    expect(key(event({ ...message, message_id: "om_retry" }))).toBe(first);
    expect(
      key(event({ ...message, message_id: "om_repeat", create_time: "1710000001000" })),
    ).not.toBe(first);
  });

  it("does not collide across senders, chats, or content", () => {
    const first = key(event());
    expect(key(event({}, "ou-other"))).not.toBe(first);
    expect(key(event({ chat_id: "oc-other" }))).not.toBe(first);
    expect(key(event({ content: JSON.stringify({ text: "bye" }) }))).not.toBe(first);
  });

  it.each([
    { name: "text without time", message: { create_time: undefined } },
    { name: "text with malformed time", message: { create_time: "1710000000000ms" } },
    { name: "post without time", message: { ...post, create_time: undefined } },
  ])("uses message_id for $name", ({ message }) => {
    expect(key(event(message))).toBe("om_first");
  });

  it.each([true, false])("isolates post topics with root_id present=%s", (withRoot) => {
    const topic = {
      ...post,
      chat_id: "oc-topic-group",
      chat_type: "topic_group" as const,
      root_id: withRoot ? "om_root_a" : undefined,
      thread_id: "omt_a",
    };
    const first = key(event(topic));
    const other = key(
      event({
        ...topic,
        message_id: "om_other",
        root_id: withRoot ? "om_root_b" : undefined,
        thread_id: "omt_b",
      }),
    );
    expect(first).toBeDefined();
    expect(other).toBeDefined();
    expect(first).not.toBe("om_first");
    expect(other).not.toBe("om_other");
    expect(other).not.toBe(first);
    expect(key(event({ ...topic, message_id: "om_retry" }))).toBe(first);
  });

  it("keeps media keyed by message_id plus media key", () => {
    expect(key(event({ message_type: "image", content: '{"image_key":"img_123"}' }))).toBe(
      JSON.stringify(["om_first", "image_key:img_123"]),
    );
  });

  it("preserves grouped rich-post replay keys, including duplicates and invalid-key filtering", () => {
    expect(
      key(
        event({
          ...post,
          content: JSON.stringify({
            title: "",
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
        }),
      ),
    ).toBe(
      JSON.stringify([
        "om_first",
        "image_key:shared",
        "image_key:shared",
        "file_key:file_first",
        "file_key:shared",
        "file_key:shared",
        "file_key:file_last",
      ]),
    );
  });

  it("keeps the shipped captioned-post replay identity when files[] are present", () => {
    expect(
      key(
        event({
          ...post,
          create_time: undefined,
          content: JSON.stringify({
            title: "",
            content: [[{ tag: "text", text: "这是账本" }]],
            files: [{ file_key: "file_report", file_name: "report.csv", is_folder: false }],
          }),
        }),
      ),
    ).toBe("om_first");
  });

  it("keeps inline-media replay identity despite topic fields and top-level files[]", () => {
    expect(
      key(
        event({
          ...post,
          chat_type: "topic_group",
          root_id: "om_root",
          thread_id: "omt_topic",
          content: JSON.stringify({
            title: "",
            content: [[{ tag: "img", image_key: "img_inline" }]],
            files: [{ file_key: "file_extra", file_name: "extra.csv", is_folder: false }],
          }),
        }),
      ),
    ).toBe(JSON.stringify(["om_first", "image_key:img_inline"]));
  });
});
