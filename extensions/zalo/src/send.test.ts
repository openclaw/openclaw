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

const cfg = { channels: { zalo: { botToken: "zalo-token" } } };

describe("zalo send", () => {
  beforeEach(() => {
    sendMessageMock.mockReset();
    sendPhotoMock.mockReset();
    resolveZaloProxyFetchMock.mockReset();
    resolveZaloProxyFetchMock.mockReturnValue(undefined);
  });

  it("fails fast for missing token or blank photo URLs", async () => {
    await expect(sendMessageZalo("dm-chat-3", "hello", { cfg: {} })).rejects.toThrow(
      "No Zalo bot token configured",
    );

    await expect(sendMessageZalo("dm-chat-4", "", { cfg, mediaUrl: "   " })).rejects.toThrow(
      "No photo URL provided",
    );

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
        cfg,
      });
      const result = await sendMessageZalo("dm-chat-surrogate-caption", boundaryText, {
        cfg,
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
      expect(result.messageId).toBe("z-photo-surrogate");
      expect(result.receipt.platformMessageIds).toEqual(["z-photo-surrogate"]);
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
    expect(result.messageId).toBe("z-photo-2");
    expect(result.receipt.platformMessageIds).toEqual(["z-photo-2"]);
  });

  it("preserves handoff rejection identity without changing provider failures", async () => {
    const providerError = new Error("provider unavailable");
    sendMessageMock.mockRejectedValueOnce(providerError);

    await expect(sendMessageZalo("dm-chat-provider-error", "hello", { cfg })).rejects.toBe(
      providerError,
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
        cfg,
        assertDirectAdapterHandoff,
      }),
    ).rejects.toBe(authorityError);
    expect(assertDirectAdapterHandoff).toHaveBeenCalledOnce();
  });
});
