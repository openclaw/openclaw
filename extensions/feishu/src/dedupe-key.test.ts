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
const richPost = (elements: object[], message: Partial<Message> = {}, files?: object[]) => ({
  message_type: "post",
  content: JSON.stringify({ title: "", content: [elements], files }),
  ...message,
});
const post = richPost([{ tag: "text", text: "hello" }]);
const image = (image_key: string) => ({ tag: "img", image_key });
const media = (file_key: string) => ({ tag: "media", file_key });
const files = [{ file_key: "file_report", file_name: "report.csv", is_folder: false }];
const mediaKey = (...parts: string[]) => JSON.stringify(["om_first", ...parts]);

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
    const topic = (id: string, message_id = "om_first") => ({
      ...post,
      message_id,
      chat_id: "oc-topic-group",
      chat_type: "topic_group" as const,
      root_id: withRoot ? `om_root_${id}` : undefined,
      thread_id: `omt_${id}`,
    });
    const first = key(topic("a"));
    const other = key(topic("b", "om_other"));
    expect(first).toBeDefined();
    expect(other).toBeDefined();
    expect(first).not.toBe("om_first");
    expect(other).not.toBe("om_other");
    expect(other).not.toBe(first);
    expect(key(topic("a", "om_retry"))).toBe(first);
  });

  it.each([
    [
      "image media keys",
      { message_type: "image", content: '{"image_key":"img_123"}' },
      mediaKey("image_key:img_123"),
    ],
    [
      "grouped inline keys preserve duplicates, filter invalid keys and ignore topic and files[]",
      richPost(
        [
          media("file_first"),
          image("shared"),
          image("shared"),
          image("invalid/key"),
          media("shared"),
          media("shared"),
          media("file_last"),
        ],
        { chat_type: "topic_group", root_id: "om_root", thread_id: "omt_topic" },
        files,
      ),
      mediaKey(
        "image_key:shared",
        "image_key:shared",
        "file_key:file_first",
        "file_key:shared",
        "file_key:shared",
        "file_key:file_last",
      ),
    ],
  ] as const)("preserves %s", (_name, message, expected) => {
    expect(key(message)).toBe(expected);
  });
});
