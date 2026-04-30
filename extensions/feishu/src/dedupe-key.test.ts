import { describe, expect, it } from "vitest";
import { resolveFeishuMessageDedupeKey } from "./dedupe-key.js";
import type { FeishuMessageEvent } from "./event-types.js";

function makeEvent(params: {
  messageId: string;
  messageType: string;
  content: string;
}): FeishuMessageEvent {
  return {
    sender: {
      sender_id: { open_id: "ou_sender" },
      sender_type: "user",
    },
    message: {
      message_id: params.messageId,
      chat_id: "oc_chat",
      chat_type: "p2p",
      message_type: params.messageType,
      content: params.content,
    },
  };
}

describe("resolveFeishuMessageDedupeKey", () => {
  it("returns the bare message_id for text messages", () => {
    const event = makeEvent({
      messageId: "om_text",
      messageType: "text",
      content: JSON.stringify({ text: "hi" }),
    });
    expect(resolveFeishuMessageDedupeKey(event)).toBe("om_text");
  });

  it("returns the bare message_id for image messages even when a file_key field is present", () => {
    // Only audio is affected by the upstream message_id reuse bug (#75057).
    // Other media types stay on plain message_id dedupe to preserve existing
    // behavior.
    const event = makeEvent({
      messageId: "om_image",
      messageType: "image",
      content: JSON.stringify({ image_key: "img_key", file_key: "ignored" }),
    });
    expect(resolveFeishuMessageDedupeKey(event)).toBe("om_image");
  });

  it("folds file_key into the dedupe key for audio messages", () => {
    const event = makeEvent({
      messageId: "om_dup",
      messageType: "audio",
      content: JSON.stringify({ file_key: "audio_alpha", duration: 1234 }),
    });
    expect(resolveFeishuMessageDedupeKey(event)).toBe("om_dup:audio:audio_alpha");
  });

  it("yields distinct dedupe keys when the same message_id is reused for different audio uploads (#75057)", () => {
    const first = makeEvent({
      messageId: "om_dup",
      messageType: "audio",
      content: JSON.stringify({ file_key: "audio_alpha" }),
    });
    const second = makeEvent({
      messageId: "om_dup",
      messageType: "audio",
      content: JSON.stringify({ file_key: "audio_beta" }),
    });
    expect(resolveFeishuMessageDedupeKey(first)).not.toBe(resolveFeishuMessageDedupeKey(second));
  });

  it("yields the same dedupe key for an audio repeat with identical message_id and file_key", () => {
    const first = makeEvent({
      messageId: "om_dup",
      messageType: "audio",
      content: JSON.stringify({ file_key: "audio_alpha" }),
    });
    const second = makeEvent({
      messageId: "om_dup",
      messageType: "audio",
      content: JSON.stringify({ file_key: "audio_alpha" }),
    });
    expect(resolveFeishuMessageDedupeKey(first)).toBe(resolveFeishuMessageDedupeKey(second));
  });

  it("falls back to message_id when audio content is missing or unparseable", () => {
    const noFileKey = makeEvent({
      messageId: "om_audio_partial",
      messageType: "audio",
      content: JSON.stringify({ duration: 500 }),
    });
    expect(resolveFeishuMessageDedupeKey(noFileKey)).toBe("om_audio_partial");

    const malformed = makeEvent({
      messageId: "om_audio_bad",
      messageType: "audio",
      content: "not json",
    });
    expect(resolveFeishuMessageDedupeKey(malformed)).toBe("om_audio_bad");

    const blankFileKey = makeEvent({
      messageId: "om_audio_blank",
      messageType: "audio",
      content: JSON.stringify({ file_key: "   " }),
    });
    expect(resolveFeishuMessageDedupeKey(blankFileKey)).toBe("om_audio_blank");
  });
});
