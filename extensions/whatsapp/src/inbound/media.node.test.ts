import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  mockExtractMessageContent,
  mockGetContentType,
  mockNormalizeMessageContent,
} from "../../../../test/mocks/baileys.js";
import { downloadInboundMedia, downloadQuotedInboundMedia } from "./media.js";
type MockMessageInput = Parameters<typeof mockNormalizeMessageContent>[0];

const { downloadMediaMessage, saveMediaStream } = vi.hoisted(() => ({
  downloadMediaMessage: vi.fn(),
  saveMediaStream: vi.fn(),
}));

vi.mock("baileys", () => ({
  DisconnectReason: { loggedOut: 401 },
  extractMessageContent: (msg: MockMessageInput) => mockExtractMessageContent(msg),
  getContentType: (msg: MockMessageInput) => mockGetContentType(msg),
  normalizeMessageContent: (msg: MockMessageInput) => mockNormalizeMessageContent(msg),
  downloadMediaMessage,
}));

// mock-isolation: Exercise inbound media streams without writing to the real media store.
vi.mock("openclaw/plugin-sdk/media-store", () => ({ saveMediaStream }));

const mockSock = {
  updateMediaMessage: vi.fn(),
  logger: { child: () => ({}) },
  user: {
    id: "15559876543:7@s.whatsapp.net",
    lid: "277038292303944@lid",
    phoneNumber: "15559876543@s.whatsapp.net",
  },
};
const SAVED = { id: "saved-media", path: "/tmp/saved-media", size: 15 };
const IMAGE = { imageMessage: { mimetype: "image/jpeg" } };

function download(message: Record<string, unknown>, maxBytes?: number) {
  return downloadInboundMedia({ message } as never, mockSock as never, maxBytes);
}

describe("downloadInboundMedia", () => {
  beforeEach(() => {
    downloadMediaMessage.mockReset().mockImplementation(() => Readable.from([Buffer.alloc(15)]));
    saveMediaStream.mockReset();
    saveMediaStream.mockImplementation(async (_stream, contentType) => ({ ...SAVED, contentType }));
  });

  it("returns undefined for messages without media", async () => {
    expect(await download({ conversation: "hello" })).toBeUndefined();
  });

  it.each([
    [{ audioMessage: {} }, "audio/ogg; codecs=opus"],
    [{ imageMessage: {} }, "image/jpeg"],
    [{ videoMessage: {} }, "video/mp4"],
    [{ ptvMessage: {} }, "video/mp4"],
    [{ stickerMessage: {} }, "image/webp"],
  ] as const)("downloads %j with MIME %s", async (message, mimetype) => {
    expect(await download(message)).toEqual({
      saved: { ...SAVED, contentType: mimetype },
      mimetype,
      fileName: undefined,
    });
  });

  it("forwards streams and the configured cap, propagating store rejection", async () => {
    const stream = Readable.from([Buffer.alloc(4), Buffer.alloc(4)]);
    const error = new Error("Media exceeds limit");
    downloadMediaMessage.mockReturnValueOnce(stream);
    saveMediaStream.mockRejectedValueOnce(error);
    await expect(download(IMAGE, 7)).rejects.toBe(error);
    expect(downloadMediaMessage.mock.calls[0]?.[1]).toBe("stream");
    expect(saveMediaStream).toHaveBeenCalledWith(stream, "image/jpeg", "inbound", 7, undefined);
  });

  it.each([
    { name: "the bot's LID identity", participant: "277038292303944@lid", expectedFromMe: true },
    { name: "another sender", participant: "15550000000@s.whatsapp.net", expectedFromMe: false },
  ])("preserves quoted media authorship for $name", async ({ participant, expectedFromMe }) => {
    const contextInfo = { stanzaId: "quoted-image", participant, quotedMessage: IMAGE };
    await downloadQuotedInboundMedia(
      {
        key: { remoteJid: "120363000000000000@g.us", id: "reply-1", fromMe: false },
        message: { extendedTextMessage: { text: "inspect this", contextInfo } },
      } as never,
      mockSock as never,
    );

    expect(downloadMediaMessage.mock.calls[0]?.[0]).toMatchObject({
      key: { fromMe: expectedFromMe, id: "quoted-image", participant },
    });
  });
});
