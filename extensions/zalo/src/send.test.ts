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

  it("splits text and photo captions past the 2000-char limit without losing or cutting characters", async () => {
    let textMessageId = 0;
    sendMessageMock.mockImplementation(async () => ({
      ok: true,
      result: { message_id: `z-text-${++textMessageId}` },
    }));
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
    // 2001 UTF-16 units: the emoji cannot fit in the first 2000 and must not be split.
    const boundaryText = `${"a".repeat(1999)}🐱`;

    try {
      const textResult = await sendMessageZalo("dm-chat-surrogate-text", boundaryText, {
        token: "zalo-token",
      });
      expect(sendMessageMock.mock.calls.map((call) => call[1]?.text)).toEqual([
        "a".repeat(1999),
        "🐱",
      ]);
      expect(requireSuccessfulSend(textResult, "z-text-2").receipt.platformMessageIds).toEqual([
        "z-text-1",
        "z-text-2",
      ]);

      sendMessageMock.mockClear();
      const captionResult = await sendMessageZalo("dm-chat-surrogate-caption", boundaryText, {
        token: "zalo-token",
        mediaUrl: "https://example.com/photo.jpg",
      });

      // Zalo would cut the caption, so the photo goes bare and the text follows it whole.
      expect(fetcher).toHaveBeenCalledOnce();
      expect(fetcher.mock.calls[0]?.[1]?.body).toBe(
        JSON.stringify({
          chat_id: "dm-chat-surrogate-caption",
          photo: "https://example.com/photo.jpg",
        }),
      );
      expect(sendMessageMock.mock.calls.map((call) => call[1])).toEqual([
        { chat_id: "dm-chat-surrogate-caption", text: "a".repeat(1999) },
        { chat_id: "dm-chat-surrogate-caption", text: "🐱" },
      ]);
      expect(requireSuccessfulSend(captionResult, "z-text-4").receipt.platformMessageIds).toEqual([
        "z-photo-surrogate",
        "z-text-3",
        "z-text-4",
      ]);
    } finally {
      resolvePhotoHost.mockRestore();
    }
  });

  it("keeps a caption within the limit on the photo", async () => {
    sendPhotoMock.mockResolvedValueOnce({ ok: true, result: { message_id: "z-photo" } });
    const caption = "a".repeat(2000);

    const result = await sendMessageZalo("dm-chat", caption, {
      token: "zalo-token",
      mediaUrl: "https://example.com/photo.jpg",
    });

    expect(sendPhotoMock.mock.calls[0]?.[1]).toEqual({
      chat_id: "dm-chat",
      photo: "https://example.com/photo.jpg",
      caption,
    });
    expect(sendMessageMock).not.toHaveBeenCalled();
    requireSuccessfulSend(result, "z-photo");
  });

  it("reports a failed follow-up text with the photo still on the receipt", async () => {
    sendPhotoMock.mockResolvedValueOnce({ ok: true, result: { message_id: "z-photo" } });
    sendMessageMock.mockResolvedValueOnce({ ok: false });
    const onDeliveryResult = vi.fn();

    const result = await sendMessageZalo("dm-chat", "word ".repeat(500), {
      token: "zalo-token",
      mediaUrl: "https://example.com/photo.jpg",
      onDeliveryResult,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Failed to send message");
    expect(result.receipt.platformMessageIds).toEqual(["z-photo"]);
    // The accepted photo was reported before the text request that failed.
    expect(onDeliveryResult).toHaveBeenCalledOnce();
    expect(onDeliveryResult.mock.calls[0]?.[0]).toMatchObject({ messageId: "z-photo" });
    expect(onDeliveryResult.mock.invocationCallOrder[0]).toBeLessThan(
      sendMessageMock.mock.invocationCallOrder[0]!,
    );
  });

  it("reports each accepted part of a split text, and nothing for a single message", async () => {
    let textMessageId = 0;
    sendMessageMock.mockImplementation(async () => ({
      ok: true,
      result: { message_id: `z-part-${++textMessageId}` },
    }));
    const onDeliveryResult = vi.fn();

    await sendMessageZalo("dm-chat", "short", { token: "zalo-token", onDeliveryResult });
    expect(onDeliveryResult).not.toHaveBeenCalled();

    await sendMessageZalo("dm-chat", "word ".repeat(500), {
      token: "zalo-token",
      onDeliveryResult,
    });
    expect(onDeliveryResult.mock.calls.map((call) => call[0].messageId)).toEqual([
      "z-part-2",
      "z-part-3",
    ]);
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
