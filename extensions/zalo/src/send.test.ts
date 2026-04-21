import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMessageMock = vi.fn();
const sendPhotoMock = vi.fn();
const resolveZaloProxyFetchMock = vi.fn();
const prepareHostedZaloMediaUrlMock = vi.fn();

vi.mock("./api.js", () => ({
  sendMessage: (...args: unknown[]) => sendMessageMock(...args),
  sendPhoto: (...args: unknown[]) => sendPhotoMock(...args),
}));

vi.mock("./proxy.js", () => ({
  resolveZaloProxyFetch: (...args: unknown[]) => resolveZaloProxyFetchMock(...args),
}));

vi.mock("./outbound-media.js", () => ({
  prepareHostedZaloMediaUrl: (...args: unknown[]) => prepareHostedZaloMediaUrlMock(...args),
}));

import { sendMessageZalo, sendPhotoZalo } from "./send.js";

describe("zalo send", () => {
  beforeEach(() => {
    sendMessageMock.mockReset();
    sendPhotoMock.mockReset();
    resolveZaloProxyFetchMock.mockReset();
    resolveZaloProxyFetchMock.mockReturnValue(undefined);
    prepareHostedZaloMediaUrlMock.mockReset();
  });

  it("sends text messages through the message API", async () => {
    sendMessageMock.mockResolvedValueOnce({
      ok: true,
      result: { message_id: "z-msg-1" },
    });

    const result = await sendMessageZalo("dm-chat-1", "hello there", {
      token: "zalo-token",
    });

    expect(sendMessageMock).toHaveBeenCalledWith(
      "zalo-token",
      {
        chat_id: "dm-chat-1",
        text: "hello there",
      },
      undefined,
    );
    expect(sendPhotoMock).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, messageId: "z-msg-1" });
  });

  it("routes media-bearing sends through the photo API and uses text as caption", async () => {
    prepareHostedZaloMediaUrlMock.mockResolvedValueOnce(
      "https://gateway.example.com/zalo-webhook/media/abc?token=secret",
    );
    sendPhotoMock.mockResolvedValueOnce({
      ok: true,
      result: { message_id: "z-photo-1" },
    });

    const result = await sendMessageZalo("dm-chat-2", "caption text", {
      cfg: {
        channels: {
          zalo: {
            botToken: "zalo-token",
            webhookUrl: "https://gateway.example.com/zalo-webhook",
          },
        },
      } as never,
      mediaUrl: "https://example.com/photo.jpg",
      caption: "ignored fallback caption",
    });

    expect(sendPhotoMock).toHaveBeenCalledWith(
      "zalo-token",
      {
        chat_id: "dm-chat-2",
        photo: "https://gateway.example.com/zalo-webhook/media/abc?token=secret",
        caption: "caption text",
      },
      undefined,
    );
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, messageId: "z-photo-1" });
  });

  it("fails fast for missing token or blank photo URLs", async () => {
    await expect(sendMessageZalo("dm-chat-3", "hello", {})).resolves.toEqual({
      ok: false,
      error: "No Zalo bot token configured",
    });

    await expect(
      sendPhotoZalo("dm-chat-4", "   ", {
        token: "zalo-token",
      }),
    ).resolves.toEqual({
      ok: false,
      error: "No photo URL provided",
    });

    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(sendPhotoMock).not.toHaveBeenCalled();
  });

  it("fails closed for media sends without a configured webhookUrl", async () => {
    await expect(
      sendPhotoZalo("dm-chat-6", "https://example.com/photo.jpg", {
        token: "zalo-token",
      }),
    ).resolves.toEqual({
      ok: false,
      error: "Zalo photo sends require a configured webhookUrl to host media safely",
    });

    expect(prepareHostedZaloMediaUrlMock).not.toHaveBeenCalled();
    expect(sendPhotoMock).not.toHaveBeenCalled();
  });

  it("re-hosts cfg-backed media sends before forwarding them to Zalo", async () => {
    prepareHostedZaloMediaUrlMock.mockResolvedValueOnce(
      "https://gateway.example.com/zalo-webhook/media/abc?token=secret",
    );
    sendPhotoMock.mockResolvedValueOnce({
      ok: true,
      result: { message_id: "z-photo-2" },
    });

    const result = await sendPhotoZalo("dm-chat-5", "https://example.com/photo.jpg", {
      cfg: {
        channels: {
          zalo: {
            botToken: "zalo-token",
            webhookUrl: "https://gateway.example.com/zalo-webhook",
          },
        },
      } as never,
    });

    expect(prepareHostedZaloMediaUrlMock).toHaveBeenCalledWith({
      mediaUrl: "https://example.com/photo.jpg",
      webhookUrl: "https://gateway.example.com/zalo-webhook",
      webhookPath: undefined,
      maxBytes: 5 * 1024 * 1024,
    });
    expect(sendPhotoMock).toHaveBeenCalledWith(
      "zalo-token",
      {
        chat_id: "dm-chat-5",
        photo: "https://gateway.example.com/zalo-webhook/media/abc?token=secret",
        caption: undefined,
      },
      undefined,
    );
    expect(result).toEqual({ ok: true, messageId: "z-photo-2" });
  });
});
