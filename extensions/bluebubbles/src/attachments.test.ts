import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./test-mocks.js";
import type { BlueBubblesAttachment } from "./types.js";
import { downloadBlueBubblesAttachment, sendBlueBubblesAttachment } from "./attachments.js";
import { getCachedBlueBubblesPrivateApiStatus } from "./probe.js";
import { installBlueBubblesFetchTestHooks } from "./test-harness.js";

const mockFetch = vi.fn();

installBlueBubblesFetchTestHooks({
  mockFetch,
  privateApiStatusMock: vi.mocked(getCachedBlueBubblesPrivateApiStatus),
});

describe("downloadBlueBubblesAttachment", () => {
  it("throws when guid is missing", async () => {
    const attachment: BlueBubblesAttachment = {};
    await expect(
      downloadBlueBubblesAttachment(attachment, {
        serverUrl: "http://localhost:1234",
        password: "test-password",
      }),
    ).rejects.toThrow("guid is required");
  });

  it("throws when guid is empty string", async () => {
    const attachment: BlueBubblesAttachment = { guid: "  " };
    await expect(
      downloadBlueBubblesAttachment(attachment, {
        serverUrl: "http://localhost:1234",
        password: "test-password",
      }),
    ).rejects.toThrow("guid is required");
  });

  it("throws when serverUrl is missing", async () => {
    const attachment: BlueBubblesAttachment = { guid: "att-123" };
    await expect(downloadBlueBubblesAttachment(attachment, {})).rejects.toThrow(
      "serverUrl is required",
    );
  });

  it("throws when password is missing", async () => {
    const attachment: BlueBubblesAttachment = { guid: "att-123" };
    await expect(
      downloadBlueBubblesAttachment(attachment, {
        serverUrl: "http://localhost:1234",
      }),
    ).rejects.toThrow("password is required");
  });

  it("downloads attachment successfully", async () => {
    const mockBuffer = new Uint8Array([1, 2, 3, 4]);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ "content-type": "image/png" }),
      arrayBuffer: () => Promise.resolve(mockBuffer.buffer),
    });

    const attachment: BlueBubblesAttachment = { guid: "att-123" };
    const result = await downloadBlueBubblesAttachment(attachment, {
      serverUrl: "http://localhost:1234",
      password: "test-password",
    });

    expect(result.buffer).toEqual(mockBuffer);
    expect(result.contentType).toBe("image/png");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/attachment/att-123/download"),
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("includes password in URL query", async () => {
    const mockBuffer = new Uint8Array([1, 2, 3, 4]);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ "content-type": "image/jpeg" }),
      arrayBuffer: () => Promise.resolve(mockBuffer.buffer),
    });

    const attachment: BlueBubblesAttachment = { guid: "att-456" };
    await downloadBlueBubblesAttachment(attachment, {
      serverUrl: "http://localhost:1234",
      password: "my-secret-password",
    });

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("password=my-secret-password");
  });

  it("encodes guid in URL", async () => {
    const mockBuffer = new Uint8Array([1]);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers(),
      arrayBuffer: () => Promise.resolve(mockBuffer.buffer),
    });

    const attachment: BlueBubblesAttachment = { guid: "att/with/special chars" };
    await downloadBlueBubblesAttachment(attachment, {
      serverUrl: "http://localhost:1234",
      password: "test",
    });

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("att%2Fwith%2Fspecial%20chars");
  });

  it("throws on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: () => Promise.resolve("Attachment not found"),
    });

    const attachment: BlueBubblesAttachment = { guid: "att-missing" };
    await expect(
      downloadBlueBubblesAttachment(attachment, {
        serverUrl: "http://localhost:1234",
        password: "test",
      }),
    ).rejects.toThrow("download failed (404): Attachment not found");
  });

  it("throws when attachment exceeds max bytes", async () => {
    const largeBuffer = new Uint8Array(10 * 1024 * 1024);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers(),
      arrayBuffer: () => Promise.resolve(largeBuffer.buffer),
    });

    const attachment: BlueBubblesAttachment = { guid: "att-large" };
    await expect(
      downloadBlueBubblesAttachment(attachment, {
        serverUrl: "http://localhost:1234",
        password: "test",
        maxBytes: 5 * 1024 * 1024,
      }),
    ).rejects.toThrow("too large");
  });

  it("uses default max bytes when not specified", async () => {
    const largeBuffer = new Uint8Array(9 * 1024 * 1024);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers(),
      arrayBuffer: () => Promise.resolve(largeBuffer.buffer),
    });

    const attachment: BlueBubblesAttachment = { guid: "att-large" };
    await expect(
      downloadBlueBubblesAttachment(attachment, {
        serverUrl: "http://localhost:1234",
        password: "test",
      }),
    ).rejects.toThrow("too large");
  });

  it("uses attachment mimeType as fallback when response has no content-type", async () => {
    const mockBuffer = new Uint8Array([1, 2, 3]);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers(),
      arrayBuffer: () => Promise.resolve(mockBuffer.buffer),
    });

    const attachment: BlueBubblesAttachment = {
      guid: "att-789",
      mimeType: "video/mp4",
    };
    const result = await downloadBlueBubblesAttachment(attachment, {
      serverUrl: "http://localhost:1234",
      password: "test",
    });

    expect(result.contentType).toBe("video/mp4");
  });

  it("prefers response content-type over attachment mimeType", async () => {
    const mockBuffer = new Uint8Array([1, 2, 3]);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ "content-type": "image/webp" }),
      arrayBuffer: () => Promise.resolve(mockBuffer.buffer),
    });

    const attachment: BlueBubblesAttachment = {
      guid: "att-xyz",
      mimeType: "image/png",
    };
    const result = await downloadBlueBubblesAttachment(attachment, {
      serverUrl: "http://localhost:1234",
      password: "test",
    });

    expect(result.contentType).toBe("image/webp");
  });

  it("resolves credentials from config when opts not provided", async () => {
    const mockBuffer = new Uint8Array([1]);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers(),
      arrayBuffer: () => Promise.resolve(mockBuffer.buffer),
    });

    const attachment: BlueBubblesAttachment = { guid: "att-config" };
    const result = await downloadBlueBubblesAttachment(attachment, {
      cfg: {
        channels: {
          bluebubbles: {
            serverUrl: "http://config-server:5678",
            password: "config-password",
          },
        },
      },
    });

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("config-server:5678");
    expect(calledUrl).toContain("password=config-password");
    expect(result.buffer).toEqual(new Uint8Array([1]));
  });
});

describe("sendBlueBubblesAttachment", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
    vi.mocked(getCachedBlueBubblesPrivateApiStatus).mockReset();
    vi.mocked(getCachedBlueBubblesPrivateApiStatus).mockReturnValue(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function decodeBody(body: Uint8Array) {
    return Buffer.from(body).toString("utf8");
  }

  it("marks voice memos when asVoice is true and mp3 is provided", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ messageId: "msg-1" })),
    });

    await sendBlueBubblesAttachment({
      to: "chat_guid:iMessage;-;+15551234567",
      buffer: new Uint8Array([1, 2, 3]),
      filename: "voice.mp3",
      contentType: "audio/mpeg",
      asVoice: true,
      opts: { serverUrl: "http://localhost:1234", password: "test" },
    });

    const body = mockFetch.mock.calls[0][1]?.body as Uint8Array;
    const bodyText = decodeBody(body);
    expect(bodyText).toContain('name="isAudioMessage"');
    expect(bodyText).toContain("true");
    expect(bodyText).toContain('filename="voice.mp3"');
  });

  it("normalizes mp3 filenames for voice memos", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ messageId: "msg-2" })),
    });

    await sendBlueBubblesAttachment({
      to: "chat_guid:iMessage;-;+15551234567",
      buffer: new Uint8Array([1, 2, 3]),
      filename: "voice",
      contentType: "audio/mpeg",
      asVoice: true,
      opts: { serverUrl: "http://localhost:1234", password: "test" },
    });

    const body = mockFetch.mock.calls[0][1]?.body as Uint8Array;
    const bodyText = decodeBody(body);
    expect(bodyText).toContain('filename="voice.mp3"');
    expect(bodyText).toContain('name="voice.mp3"');
  });

  it("throws when asVoice is true but media is not audio", async () => {
    await expect(
      sendBlueBubblesAttachment({
        to: "chat_guid:iMessage;-;+15551234567",
        buffer: new Uint8Array([1, 2, 3]),
        filename: "image.png",
        contentType: "image/png",
        asVoice: true,
        opts: { serverUrl: "http://localhost:1234", password: "test" },
      }),
    ).rejects.toThrow("voice messages require audio");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("throws when asVoice is true but audio is not mp3 or caf", async () => {
    await expect(
      sendBlueBubblesAttachment({
        to: "chat_guid:iMessage;-;+15551234567",
        buffer: new Uint8Array([1, 2, 3]),
        filename: "voice.wav",
        contentType: "audio/wav",
        asVoice: true,
        opts: { serverUrl: "http://localhost:1234", password: "test" },
      }),
    ).rejects.toThrow("require mp3 or caf");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("sanitizes filenames before sending", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ messageId: "msg-3" })),
    });

    await sendBlueBubblesAttachment({
      to: "chat_guid:iMessage;-;+15551234567",
      buffer: new Uint8Array([1, 2, 3]),
      filename: "../evil.mp3",
      contentType: "audio/mpeg",
      opts: { serverUrl: "http://localhost:1234", password: "test" },
    });

    const body = mockFetch.mock.calls[0][1]?.body as Uint8Array;
    const bodyText = decodeBody(body);
    expect(bodyText).toContain('filename="evil.mp3"');
    expect(bodyText).toContain('name="evil.mp3"');
  });

  it("downgrades attachment reply threading when private API is disabled", async () => {
    vi.mocked(getCachedBlueBubblesPrivateApiStatus).mockReturnValueOnce(false);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ messageId: "msg-4" })),
    });

    await sendBlueBubblesAttachment({
      to: "chat_guid:iMessage;-;+15551234567",
      buffer: new Uint8Array([1, 2, 3]),
      filename: "photo.jpg",
      contentType: "image/jpeg",
      replyToMessageGuid: "reply-guid-123",
      opts: { serverUrl: "http://localhost:1234", password: "test" },
    });

    const body = mockFetch.mock.calls[0][1]?.body as Uint8Array;
    const bodyText = decodeBody(body);
    expect(bodyText).not.toContain('name="method"');
    expect(bodyText).not.toContain('name="selectedMessageGuid"');
    expect(bodyText).not.toContain('name="partIndex"');
  });
});
