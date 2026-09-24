// Zalo tests cover send plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ZaloFetch } from "./api.js";

const sendMessageMock = vi.fn();
const sendPhotoMock = vi.fn();
const resolveZaloProxyFetchMock = vi.fn();

vi.mock("./api.js", () => ({
  sendMessage: (...args: unknown[]) => sendMessageMock(...args),
  sendPhoto: (...args: unknown[]) => sendPhotoMock(...args),
}));

vi.mock("./proxy.js", () => ({
  resolveZaloProxyFetch: (...args: unknown[]) => resolveZaloProxyFetchMock(...args),
}));

import { sendMessageZalo } from "./send.js";

type ZaloSendResult = Awaited<ReturnType<typeof sendMessageZalo>>;

function requireSuccessfulSend(result: ZaloSendResult, expectedMessageId: string) {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`expected successful Zalo send: ${result.error}`);
  }
  expect(result.messageId).toBe(expectedMessageId);
  return result;
}

function expectFailedSend(result: ZaloSendResult, expectedError: string) {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("expected failed Zalo send");
  }
  expect(result.error).toBe(expectedError);
  expect(result.receipt.platformMessageIds).toStrictEqual([]);
}

describe("zalo send", () => {
  beforeEach(() => {
    sendMessageMock.mockReset();
    sendPhotoMock.mockReset();
    resolveZaloProxyFetchMock.mockReset();
    resolveZaloProxyFetchMock.mockReturnValue(undefined);
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
      undefined,
    );
    expect(sendPhotoMock).not.toHaveBeenCalled();
    const successful = requireSuccessfulSend(result, "z-msg-1");
    expect(successful.receipt.primaryPlatformMessageId).toBe("z-msg-1");
    expect(successful.receipt.platformMessageIds).toEqual(["z-msg-1"]);
    expect(successful.receipt.parts).toHaveLength(1);
    expect(successful.receipt.parts[0]?.platformMessageId).toBe("z-msg-1");
    expect(successful.receipt.parts[0]?.kind).toBe("text");
    expect(successful.receipt.parts[0]?.raw).toEqual({
      channel: "zalo",
      chatId: "dm-chat-1",
      messageId: "z-msg-1",
    });
  });

  it("routes media-bearing sends through the photo API and uses text as caption", async () => {
    sendPhotoMock.mockResolvedValueOnce({
      ok: true,
      result: { message_id: "z-photo-1" },
    });

    const result = await sendMessageZalo("dm-chat-2", "caption text", {
      token: "zalo-token",
      mediaUrl: "https://example.com/photo.jpg",
      caption: "ignored fallback caption",
    });

    expect(sendPhotoMock).toHaveBeenCalledWith(
      "zalo-token",
      {
        chat_id: "dm-chat-2",
        photo: "https://example.com/photo.jpg",
        caption: "caption text",
      },
      undefined,
      undefined,
    );
    expect(sendMessageMock).not.toHaveBeenCalled();
    const successful = requireSuccessfulSend(result, "z-photo-1");
    expect(successful.receipt.primaryPlatformMessageId).toBe("z-photo-1");
    expect(successful.receipt.platformMessageIds).toEqual(["z-photo-1"]);
    expect(successful.receipt.parts).toHaveLength(1);
    expect(successful.receipt.parts[0]?.platformMessageId).toBe("z-photo-1");
    expect(successful.receipt.parts[0]?.kind).toBe("media");
  });

  it("sends text through the message API when the media URL is whitespace", async () => {
    sendMessageMock.mockResolvedValueOnce({
      ok: true,
      result: { message_id: "z-msg-with-blank-media" },
    });

    const result = await sendMessageZalo("dm-chat-blank-media", "hello there", {
      token: "zalo-token",
      mediaUrl: "   ",
    });

    expect(sendMessageMock).toHaveBeenCalledWith(
      "zalo-token",
      {
        chat_id: "dm-chat-blank-media",
        text: "hello there",
      },
      undefined,
      undefined,
    );
    expect(sendPhotoMock).not.toHaveBeenCalled();
    expect(requireSuccessfulSend(result, "z-msg-with-blank-media").receipt.parts[0]?.kind).toBe(
      "text",
    );
  });

  it("normalizes provider and target-kind prefixes before calling the Bot API", async () => {
    sendMessageMock.mockResolvedValueOnce({
      ok: true,
      result: { message_id: "z-msg-prefixed" },
    });
    sendPhotoMock.mockResolvedValueOnce({
      ok: true,
      result: { message_id: "z-photo-prefixed" },
    });

    await sendMessageZalo("zalo:group:dm-chat-prefixed-text", "hello", {
      token: "zalo-token",
    });
    await sendMessageZalo("zl:user:dm-chat-prefixed-photo", "", {
      token: "zalo-token",
      mediaUrl: "https://example.com/photo.jpg",
    });

    expect(sendMessageMock).toHaveBeenCalledWith(
      "zalo-token",
      {
        chat_id: "dm-chat-prefixed-text",
        text: "hello",
      },
      undefined,
      undefined,
    );
    expect(sendPhotoMock).toHaveBeenCalledWith(
      "zalo-token",
      {
        chat_id: "dm-chat-prefixed-photo",
        photo: "https://example.com/photo.jpg",
        caption: undefined,
      },
      undefined,
      undefined,
    );
  });

  it("fails fast for missing token or blank photo URLs", async () => {
    const missingToken = await sendMessageZalo("dm-chat-3", "hello", {});
    expectFailedSend(missingToken, "No Zalo bot token configured");

    const blankPhoto = await sendMessageZalo("dm-chat-4", "", {
      token: "zalo-token",
      mediaUrl: "   ",
    });
    expectFailedSend(blankPhoto, "No photo URL provided");

    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(sendPhotoMock).not.toHaveBeenCalled();
  });

  it("keeps outbound text and photo captions UTF-16 safe at the 2000-char limit", async () => {
    sendMessageMock.mockResolvedValueOnce({
      ok: true,
      result: { message_id: "z-msg-surrogate" },
    });
    const api = await vi.importActual<typeof import("./api.js")>("./api.js");
    const ssrf = await import("openclaw/plugin-sdk/ssrf-runtime");
    const pinnedHost = await ssrf.resolvePinnedHostnameWithPolicy("example.com", {
      lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
    });
    const resolvePhotoHost = vi
      .spyOn(ssrf, "resolvePinnedHostnameWithPolicy")
      .mockResolvedValue(pinnedHost);
    const fetcher = vi.fn<ZaloFetch>(async () =>
      Response.json({ ok: true, result: { message_id: "z-photo-surrogate" } }),
    );
    sendPhotoMock.mockImplementationOnce(api.sendPhoto);
    resolveZaloProxyFetchMock.mockReturnValue(fetcher);
    const boundaryText = `${"a".repeat(1999)}🐱`;

    try {
      await sendMessageZalo("dm-chat-surrogate-text", boundaryText, {
        token: "zalo-token",
      });
      const result = await sendMessageZalo("dm-chat-surrogate-caption", boundaryText, {
        token: "zalo-token",
        mediaUrl: "https://example.com/photo.jpg",
      });

      expect(sendMessageMock.mock.calls[0]?.[1]?.text).toBe("a".repeat(1999));
      expect(fetcher).toHaveBeenCalledOnce();
      expect(fetcher.mock.calls[0]?.[1]?.body).toBe(
        JSON.stringify({
          chat_id: "dm-chat-surrogate-caption",
          photo: "https://example.com/photo.jpg",
          caption: "a".repeat(1999),
        }),
      );
      expect(requireSuccessfulSend(result, "z-photo-surrogate").receipt.platformMessageIds).toEqual(
        ["z-photo-surrogate"],
      );
    } finally {
      resolvePhotoHost.mockRestore();
    }
  });

  it("sends cfg-backed media directly without hosted-media rewrites", async () => {
    sendPhotoMock.mockResolvedValueOnce({
      ok: true,
      result: { message_id: "z-photo-2" },
    });

    const result = await sendMessageZalo("dm-chat-5", "", {
      cfg: {
        channels: {
          zalo: {
            botToken: "zalo-token",
            webhookUrl: "https://gateway.example.com/zalo-webhook",
          },
        },
      } as never,
      mediaUrl: "https://example.com/photo.jpg",
    });

    expect(sendPhotoMock).toHaveBeenCalledWith(
      "zalo-token",
      {
        chat_id: "dm-chat-5",
        photo: "https://example.com/photo.jpg",
        caption: undefined,
      },
      undefined,
      undefined,
    );
    expect(resolveZaloProxyFetchMock).toHaveBeenCalledOnce();
    const successful = requireSuccessfulSend(result, "z-photo-2");
    expect(successful.receipt.platformMessageIds).toEqual(["z-photo-2"]);
  });

  it("preserves handoff rejection identity without changing provider failures", async () => {
    const providerError = new Error("provider unavailable");
    sendMessageMock.mockRejectedValueOnce(providerError);

    expectFailedSend(
      await sendMessageZalo("dm-chat-provider-error", "hello", { token: "zalo-token" }),
      providerError.message,
    );

    const authorityError = new Error("source authority revoked");
    const assertDirectAdapterHandoff = vi.fn(() => {
      throw authorityError;
    });
    sendMessageMock.mockImplementationOnce(
      async (_token, _params, _fetcher, assertCurrent: (() => void) | undefined) => {
        assertCurrent?.();
        return { ok: true, result: { message_id: "unexpected" } };
      },
    );

    await expect(
      sendMessageZalo("dm-chat-revoked", "hello", {
        token: "zalo-token",
        assertDirectAdapterHandoff,
      }),
    ).rejects.toBe(authorityError);
    expect(assertDirectAdapterHandoff).toHaveBeenCalledOnce();
  });
});
