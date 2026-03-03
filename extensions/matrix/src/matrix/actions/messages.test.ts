import { describe, expect, it, vi } from "vitest";

const sendMessageMatrixMock = vi.hoisted(() =>
  vi.fn(async () => ({
    messageId: "evt-1",
    roomId: "!room:example",
  })),
);

vi.mock("../send.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../send.js")>();
  return {
    ...actual,
    sendMessageMatrix: sendMessageMatrixMock,
  };
});

import { sendMatrixMessage } from "./messages.js";

describe("sendMatrixMessage", () => {
  it("forwards audioAsVoice to sendMessageMatrix", async () => {
    sendMessageMatrixMock.mockClear();

    await sendMatrixMessage("!room:example", "Voice note", {
      mediaUrl: "https://example.com/voice.ogg",
      replyToId: "$reply",
      threadId: "$thread",
      audioAsVoice: true,
    });

    expect(sendMessageMatrixMock).toHaveBeenCalledWith("!room:example", "Voice note", {
      mediaUrl: "https://example.com/voice.ogg",
      replyToId: "$reply",
      threadId: "$thread",
      audioAsVoice: true,
      client: undefined,
      timeoutMs: undefined,
    });
  });
});
