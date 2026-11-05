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

const cfg = {
  channels: { zalo: { botToken: "zalo-token", webhookUrl: "https://gateway.example.com/zalo" } },
};
const sent = (message_id: string) => ({ ok: true, result: { message_id } });
const mediaUrl = "https://example.com/photo.jpg";

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

  it.each([
    ["text", false, `${"a".repeat(1999)}🐱`],
    ["caption", true, `${"a".repeat(1999)}🐱`],
    ["empty caption", true, ""],
  ] as const)("sends UTF-16-safe %s without media rewrites", async (_name, photo, text) => {
    const api = await vi.importActual<typeof import("./api.js")>("./api.js");
    const ssrf = await import("openclaw/plugin-sdk/ssrf-runtime");
    const pinnedHost = await ssrf.resolvePinnedHostnameWithPolicy("example.com", {
      lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
    });
    const resolvePhotoHost = vi
      .spyOn(ssrf, "resolvePinnedHostnameWithPolicy")
      .mockResolvedValue(pinnedHost);
    const fetcher = vi.fn<ZaloFetch>(async () => Response.json(sent("z-sent")));
    sendMessageMock.mockImplementationOnce(api.sendMessage);
    sendPhotoMock.mockImplementationOnce(api.sendPhoto);
    resolveZaloProxyFetchMock.mockReturnValue(fetcher);

    try {
      const result = await sendMessageZalo("chat", text, {
        cfg,
        ...(photo ? { mediaUrl } : {}),
      });
      expect(fetcher).toHaveBeenCalledOnce();
      const body = fetcher.mock.calls[0]?.[1]?.body;
      if (typeof body !== "string") {
        throw new Error("Expected a JSON request body");
      }
      expect(JSON.parse(body)).toEqual({
        chat_id: "chat",
        [photo ? "photo" : "text"]: photo ? mediaUrl : "a".repeat(1999),
        ...(photo && text ? { caption: "a".repeat(1999) } : {}),
      });
      expect(result.messageId).toBe("z-sent");
      expect(result.receipt.platformMessageIds).toEqual(["z-sent"]);
    } finally {
      resolvePhotoHost.mockRestore();
    }
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
        return sent("unexpected");
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
