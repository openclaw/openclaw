import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  mockExtractMessageContent,
  mockGetContentType,
  mockNormalizeMessageContent,
} from "../../../../test/mocks/baileys.js";
import { downloadInboundMedia, downloadQuotedInboundMedia } from "./media.js";

type MockMessageInput = Parameters<typeof mockNormalizeMessageContent>[0];

const { normalizeMessageContent, downloadMediaMessage, saveMediaStream } = vi.hoisted(() => ({
  normalizeMessageContent: vi.fn((msg: MockMessageInput) => mockNormalizeMessageContent(msg)),
  downloadMediaMessage: vi.fn(),
  saveMediaStream: vi.fn(),
}));

vi.mock("baileys", () => ({
  DisconnectReason: { loggedOut: 401 },
  extractMessageContent: vi.fn((msg: MockMessageInput) => mockExtractMessageContent(msg)),
  getContentType: vi.fn((msg: MockMessageInput) => mockGetContentType(msg)),
  normalizeMessageContent,
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

function download(message: Record<string, unknown>, maxBytes?: number) {
  return downloadInboundMedia({ message } as never, mockSock as never, maxBytes);
}

async function expectMedia(message: Record<string, unknown>, mime: string, fileName?: string) {
  expect(await download(message)).toEqual({
    saved: { id: "saved-media", path: "/tmp/saved-media", size: 15, contentType: mime },
    mimetype: mime,
    fileName,
  });
}

describe("downloadInboundMedia", () => {
  beforeEach(() => {
    normalizeMessageContent.mockClear();
    downloadMediaMessage.mockClear();
    downloadMediaMessage.mockImplementation(() => Readable.from([Buffer.from("fake-media-data")]));
    saveMediaStream.mockClear();
    saveMediaStream.mockImplementation(
      async (
        stream: AsyncIterable<Buffer>,
        contentType: string | undefined,
        _subdir: string,
        maxBytes: number,
      ) => {
        let total = 0;
        for await (const chunk of stream) {
          total += chunk.byteLength;
          if (total > maxBytes) {
            throw new Error("Media exceeds limit");
          }
        }
        return { id: "saved-media", path: "/tmp/saved-media", size: total, contentType };
      },
    );
    mockSock.updateMediaMessage.mockClear();
  });

  it("returns undefined for messages without media", async () => {
    expect(await download({ conversation: "hello" })).toBeUndefined();
  });

  it.each([
    { name: "audio", message: { audioMessage: {} }, mimetype: "audio/ogg; codecs=opus" },
    { name: "image", message: { imageMessage: {} }, mimetype: "image/jpeg" },
    { name: "video", message: { videoMessage: {} }, mimetype: "video/mp4" },
    { name: "video note", message: { ptvMessage: {} }, mimetype: "video/mp4" },
    { name: "sticker", message: { stickerMessage: {} }, mimetype: "image/webp" },
  ])("defaults MIME for $name messages without explicit MIME", async ({ message, mimetype }) => {
    await expectMedia(message, mimetype);
  });

  it("preserves fileName from document messages", async () => {
    await expectMedia(
      { documentMessage: { mimetype: "application/pdf", fileName: "report.pdf" } },
      "application/pdf",
      "report.pdf",
    );
  });

  it("downloads in stream mode and rejects over the configured cap", async () => {
    downloadMediaMessage.mockImplementationOnce(() =>
      Readable.from([Buffer.alloc(4), Buffer.alloc(4)]),
    );

    await expect(download({ imageMessage: { mimetype: "image/jpeg" } }, 7)).rejects.toThrow(
      /Media exceeds/i,
    );
    expect(downloadMediaMessage.mock.calls[0]?.[1]).toBe("stream");
  });

  it.each([
    { name: "the bot's LID identity", participant: "277038292303944@lid", expectedFromMe: true },
    { name: "another sender", participant: "15550000000@s.whatsapp.net", expectedFromMe: false },
  ])("preserves quoted media authorship for $name", async ({ participant, expectedFromMe }) => {
    await downloadQuotedInboundMedia(
      {
        key: { remoteJid: "120363000000000000@g.us", id: "reply-1", fromMe: false },
        message: {
          extendedTextMessage: {
            text: "inspect this",
            contextInfo: {
              stanzaId: "quoted-image",
              participant,
              quotedMessage: { imageMessage: { mimetype: "image/jpeg" } },
            },
          },
        },
      } as never,
      mockSock as never,
    );

    expect(downloadMediaMessage.mock.calls[0]?.[0]).toMatchObject({
      key: { fromMe: expectedFromMe, id: "quoted-image", participant },
    });
  });
});
