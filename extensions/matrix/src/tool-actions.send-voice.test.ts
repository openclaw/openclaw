import { describe, expect, it, vi } from "vitest";
import type { CoreConfig } from "./types.js";

const sendMatrixMessageMock = vi.hoisted(() =>
  vi.fn(async () => ({
    messageId: "evt-1",
    roomId: "!room:example",
  })),
);

vi.mock("./matrix/actions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./matrix/actions.js")>();
  return {
    ...actual,
    sendMatrixMessage: sendMatrixMessageMock,
  };
});

import { handleMatrixAction } from "./tool-actions.js";

const cfg = {
  channels: {
    matrix: {
      actions: {
        messages: true,
      },
    },
  },
} as CoreConfig;

describe("handleMatrixAction sendMessage voice flags", () => {
  it("passes audioAsVoice through to sendMatrixMessage", async () => {
    sendMatrixMessageMock.mockClear();

    await handleMatrixAction(
      {
        action: "sendMessage",
        to: "!room:example",
        content: "Voice note",
        mediaUrl: "https://example.com/voice.ogg",
        audioAsVoice: true,
      },
      cfg,
    );

    expect(sendMatrixMessageMock).toHaveBeenCalledWith("!room:example", "Voice note", {
      mediaUrl: "https://example.com/voice.ogg",
      replyToId: undefined,
      threadId: undefined,
      audioAsVoice: true,
    });
  });

  it("supports asVoice as an alias for audioAsVoice", async () => {
    sendMatrixMessageMock.mockClear();

    await handleMatrixAction(
      {
        action: "sendMessage",
        to: "!room:example",
        content: "Voice alias",
        mediaUrl: "https://example.com/voice.ogg",
        asVoice: true,
      },
      cfg,
    );

    expect(sendMatrixMessageMock).toHaveBeenCalledWith("!room:example", "Voice alias", {
      mediaUrl: "https://example.com/voice.ogg",
      replyToId: undefined,
      threadId: undefined,
      audioAsVoice: true,
    });
  });
});
