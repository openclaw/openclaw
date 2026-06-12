import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendBlueBubblesAttachment } from "./attachments.js";
import { bluebubblesPlugin } from "./channel.js";
import { sendBlueBubblesTyping } from "./chat.js";
import { sendBlueBubblesMedia } from "./media-send.js";
import { sendBlueBubblesReaction } from "./reactions.js";
import { sendMessageBlueBubbles } from "./send.js";
import { BLUEBUBBLES_OUTBOUND_ENABLED_ENV } from "./types.js";

const mockFetch = vi.fn();
let originalFlag: string | undefined;

async function expectOutboundGate(
  action: () => Promise<unknown>,
  fetchMock = mockFetch,
): Promise<void> {
  await expect(action()).rejects.toThrow(BLUEBUBBLES_OUTBOUND_ENABLED_ENV);
  expect(fetchMock).not.toHaveBeenCalled();
}

describe("BlueBubbles outbound gate", () => {
  beforeEach(() => {
    originalFlag = process.env[BLUEBUBBLES_OUTBOUND_ENABLED_ENV];
    delete process.env[BLUEBUBBLES_OUTBOUND_ENABLED_ENV];
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
  });

  afterEach(() => {
    if (typeof originalFlag === "string") {
      process.env[BLUEBUBBLES_OUTBOUND_ENABLED_ENV] = originalFlag;
    } else {
      delete process.env[BLUEBUBBLES_OUTBOUND_ENABLED_ENV];
    }
    vi.unstubAllGlobals();
  });

  it("outbound_gate_throws_when_flag_unset", async () => {
    const cfg = {
      channels: {
        bluebubbles: {
          serverUrl: "http://localhost:1234",
          password: "test",
        },
      },
    };

    await expectOutboundGate(() =>
      sendMessageBlueBubbles("chat_guid:iMessage;-;+15551234567", "hello", {
        serverUrl: "http://localhost:1234",
        password: "test",
      }),
    );
    await expectOutboundGate(() =>
      sendMessageBlueBubbles("+15551234567", "hello", {
        serverUrl: "http://localhost:1234",
        password: "test",
      }),
    );
    await expectOutboundGate(() =>
      sendBlueBubblesAttachment({
        to: "chat_guid:iMessage;-;+15551234567",
        buffer: new Uint8Array([1, 2, 3]),
        filename: "photo.jpg",
        contentType: "image/jpeg",
        opts: { serverUrl: "http://localhost:1234", password: "test" },
      }),
    );
    await expectOutboundGate(() =>
      sendBlueBubblesMedia({
        cfg,
        to: "chat_guid:iMessage;-;+15551234567",
        mediaBuffer: new Uint8Array([1, 2, 3]),
        filename: "photo.jpg",
      }),
    );
    await expectOutboundGate(() =>
      sendBlueBubblesReaction({
        chatGuid: "iMessage;-;+15551234567",
        messageGuid: "msg-123",
        emoji: "love",
        opts: { serverUrl: "http://localhost:1234", password: "test" },
      }),
    );
    await expectOutboundGate(() =>
      sendBlueBubblesTyping("iMessage;-;+15551234567", true, {
        serverUrl: "http://localhost:1234",
        password: "test",
      }),
    );
    await expectOutboundGate(() =>
      bluebubblesPlugin.pairing.notifyApproval?.({
        cfg,
        id: "+15551234567",
      } as never),
    );
    await expectOutboundGate(() =>
      bluebubblesPlugin.outbound.sendText({
        cfg,
        to: "+15551234567",
        text: "hello",
      } as never),
    );
    await expectOutboundGate(() =>
      bluebubblesPlugin.outbound.sendMedia({
        cfg,
        to: "+15551234567",
        text: "caption",
        mediaUrl: "https://example.com/file.jpg",
      } as never),
    );
  });
});
