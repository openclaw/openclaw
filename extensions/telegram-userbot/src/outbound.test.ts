import { describe, expect, it, vi } from "vitest";
import type { UserbotClient } from "./client.js";
import type { FloodController } from "./flood-control.js";
import { chunkMessage, sendMedia, sendText, TELEGRAM_TEXT_LIMIT } from "./outbound.js";

// ---------------------------------------------------------------------------
// chunkMessage
// ---------------------------------------------------------------------------

describe("chunkMessage", () => {
  it("returns a single chunk when text is under the limit", () => {
    const text = "Hello, world!";
    const chunks = chunkMessage(text);
    expect(chunks).toEqual(["Hello, world!"]);
  });

  it("returns a single chunk when text equals the limit", () => {
    const text = "a".repeat(TELEGRAM_TEXT_LIMIT);
    const chunks = chunkMessage(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(text);
  });

  it("splits at paragraph break (double newline)", () => {
    const paragraph1 = "a".repeat(40);
    const paragraph2 = "b".repeat(40);
    const text = `${paragraph1}\n\n${paragraph2}`;
    const chunks = chunkMessage(text, 50);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(paragraph1);
    expect(chunks[1]).toBe(paragraph2);
  });

  it("splits at newline when no paragraph break available", () => {
    const line1 = "a".repeat(40);
    const line2 = "b".repeat(40);
    const text = `${line1}\n${line2}`;
    const chunks = chunkMessage(text, 50);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(line1);
    expect(chunks[1]).toBe(line2);
  });

  it("splits at space when no newline available", () => {
    const word1 = "a".repeat(40);
    const word2 = "b".repeat(40);
    const text = `${word1} ${word2}`;
    const chunks = chunkMessage(text, 50);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(word1);
    expect(chunks[1]).toBe(word2);
  });

  it("hard splits at limit when no break points exist", () => {
    const text = "a".repeat(100);
    const chunks = chunkMessage(text, 40);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toBe("a".repeat(40));
    expect(chunks[1]).toBe("a".repeat(40));
    expect(chunks[2]).toBe("a".repeat(20));
  });

  it("uses TELEGRAM_TEXT_LIMIT as default limit", () => {
    const text = "a".repeat(TELEGRAM_TEXT_LIMIT + 10);
    const chunks = chunkMessage(text);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(TELEGRAM_TEXT_LIMIT);
  });
});

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockClient(overrides?: Partial<UserbotClient>) {
  return {
    sendMessage: vi.fn().mockResolvedValue({ messageId: 100, date: 1000 }),
    sendFile: vi.fn().mockResolvedValue({ messageId: 200, date: 2000 }),
    ...overrides,
  } as unknown as UserbotClient;
}

function createMockFloodController() {
  return {
    acquire: vi.fn().mockResolvedValue(undefined),
  } as unknown as FloodController;
}

// ---------------------------------------------------------------------------
// sendText
// ---------------------------------------------------------------------------

describe("sendText", () => {
  it("calls floodController.acquire then client.sendMessage", async () => {
    const client = createMockClient();
    const fc = createMockFloodController();

    const result = await sendText({
      client,
      floodController: fc,
      chatId: 12345,
      text: "hello",
    });

    expect(fc.acquire).toHaveBeenCalledWith("12345");
    expect(client.sendMessage).toHaveBeenCalledWith(12345, "hello", {
      replyTo: undefined,
      parseMode: undefined,
    });
    expect(result.messageIds).toEqual([100]);
    expect(result.error).toBeUndefined();
  });

  it("sends multiple chunks for long messages", async () => {
    const client = createMockClient({
      sendMessage: vi
        .fn()
        .mockResolvedValueOnce({ messageId: 1, date: 100 })
        .mockResolvedValueOnce({ messageId: 2, date: 101 }),
    });
    const fc = createMockFloodController();

    const line1 = "a".repeat(40);
    const line2 = "b".repeat(40);
    const text = `${line1}\n${line2}`;

    const result = await sendText({
      client,
      floodController: fc,
      chatId: 12345,
      text,
      replyTo: 42,
      chunkLimit: 50,
    });

    // Should have been called twice (two chunks)
    expect(client.sendMessage).toHaveBeenCalledTimes(2);
    expect(result.messageIds).toEqual([1, 2]);
  });

  it("passes replyTo only to the first chunk", async () => {
    const client = createMockClient({
      sendMessage: vi
        .fn()
        .mockResolvedValueOnce({ messageId: 1, date: 100 })
        .mockResolvedValueOnce({ messageId: 2, date: 101 }),
    });
    const fc = createMockFloodController();

    const line1 = "a".repeat(40);
    const line2 = "b".repeat(40);
    const text = `${line1}\n${line2}`;

    await sendText({
      client,
      floodController: fc,
      chatId: 12345,
      text,
      replyTo: 42,
      chunkLimit: 50,
    });

    // First chunk gets replyTo, second does not
    const calls = (client.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][2]).toEqual({ replyTo: 42, parseMode: undefined });
    expect(calls[1][2]).toEqual({ replyTo: undefined, parseMode: undefined });
  });

  it("returns error on client failure", async () => {
    const client = createMockClient({
      sendMessage: vi.fn().mockRejectedValue(new Error("network timeout")),
    });
    const fc = createMockFloodController();

    const result = await sendText({
      client,
      floodController: fc,
      chatId: 12345,
      text: "hello",
    });

    expect(result.messageIds).toEqual([]);
    expect(result.error).toBe("network timeout");
  });

  it("parses channel-prefixed string chatId", async () => {
    const client = createMockClient();
    const fc = createMockFloodController();

    await sendText({
      client,
      floodController: fc,
      chatId: "telegram-userbot:67890",
      text: "hi",
    });

    // parseChannelChatId strips the prefix and converts to number
    expect(fc.acquire).toHaveBeenCalledWith("67890");
    expect(client.sendMessage).toHaveBeenCalledWith(67890, "hi", expect.anything());
  });
});

// ---------------------------------------------------------------------------
// sendMedia
// ---------------------------------------------------------------------------

describe("sendMedia", () => {
  it("calls floodController.acquire then client.sendFile", async () => {
    const client = createMockClient();
    const fc = createMockFloodController();

    const result = await sendMedia({
      client,
      floodController: fc,
      chatId: 12345,
      file: "/tmp/photo.jpg",
      caption: "nice photo",
    });

    expect(fc.acquire).toHaveBeenCalledWith("12345");
    expect(client.sendFile).toHaveBeenCalledWith(12345, "/tmp/photo.jpg", {
      caption: "nice photo",
      replyTo: undefined,
      forceDocument: undefined,
      voiceNote: undefined,
    });
    expect(result.messageId).toBe(200);
    expect(result.error).toBeUndefined();
  });

  it("passes forceDocument option", async () => {
    const client = createMockClient();
    const fc = createMockFloodController();

    await sendMedia({
      client,
      floodController: fc,
      chatId: 12345,
      file: "/tmp/video.mp4",
      forceDocument: true,
    });

    expect(client.sendFile).toHaveBeenCalledWith(12345, "/tmp/video.mp4", {
      caption: undefined,
      replyTo: undefined,
      forceDocument: true,
      voiceNote: undefined,
    });
  });

  it("returns error on client failure", async () => {
    const client = createMockClient({
      sendFile: vi.fn().mockRejectedValue(new Error("upload failed")),
    });
    const fc = createMockFloodController();

    const result = await sendMedia({
      client,
      floodController: fc,
      chatId: 12345,
      file: "/tmp/broken.bin",
    });

    expect(result.messageId).toBeUndefined();
    expect(result.error).toBe("upload failed");
  });

  it("passes voice note and replyTo options", async () => {
    const client = createMockClient();
    const fc = createMockFloodController();

    await sendMedia({
      client,
      floodController: fc,
      chatId: 12345,
      file: Buffer.from("audio data"),
      voiceNote: true,
      replyTo: 77,
    });

    expect(client.sendFile).toHaveBeenCalledWith(12345, Buffer.from("audio data"), {
      caption: undefined,
      replyTo: 77,
      forceDocument: undefined,
      voiceNote: true,
    });
  });
});
