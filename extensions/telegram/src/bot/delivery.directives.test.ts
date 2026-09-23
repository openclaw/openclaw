import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  baseDeliveryParams,
  createBot,
  createRuntime,
  deliverStructuredReplies,
  firstMockCallArg,
  loadWebMedia,
  mockMediaLoad,
  resetDeliveryMocks,
} from "./delivery.test-support.js";

describe("Telegram reply directive delivery", () => {
  beforeEach(resetDeliveryMocks);

  it("preserves prepared voice and reply fields beside literal directives", async () => {
    const sendVoice = vi.fn().mockResolvedValue({ message_id: 1, chat: { id: "123" } });
    mockMediaLoad("note.ogg", "audio/ogg", "synthetic audio");

    await deliverStructuredReplies({
      ...baseDeliveryParams,
      replies: [
        {
          text: "[[reply_to:999]] [[audio_as_voice]] Example",
          mediaUrl: "https://example.invalid/note.ogg",
          replyToId: "42",
          audioAsVoice: true,
        },
      ],
      replyToMode: "all",
      runtime: createRuntime(),
      bot: createBot({ sendVoice }),
      mediaLoader: loadWebMedia,
    });

    expect(sendVoice).toHaveBeenCalledTimes(1);
    expect(firstMockCallArg(sendVoice, 2)).toMatchObject({
      caption: "[[reply_to:999]] [[audio_as_voice]] Example",
      reply_to_message_id: 42,
    });
  });
});
