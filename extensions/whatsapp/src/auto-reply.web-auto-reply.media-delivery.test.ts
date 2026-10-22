import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { createNoisyPngBuffer, createSolidPngBuffer } from "openclaw/plugin-sdk/test-fixtures";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  createMockWebListener,
  createWebInboundDeliverySpies,
  installWebAutoReplyTestHomeHooks,
  installWebAutoReplyUnitTestHooks,
  resetLoadConfigMock,
  sendWebDirectInboundMessage,
  sendWebGroupInboundMessage,
  setLoadConfigMock,
} from "./auto-reply.test-harness.js";
import type { WebInboundCallbackMessage } from "./inbound.js";
import { createTestWebInboundMessage } from "./inbound/test-message.test-helper.js";

installWebAutoReplyTestHomeHooks();
installWebAutoReplyUnitTestHooks({ pinDns: true });

let monitorWebChannel: typeof import("./auto-reply/monitor.js").monitorWebChannel;
type ListenerFactory = NonNullable<Parameters<typeof monitorWebChannel>[1]>;
beforeAll(async () => {
  ({ monitorWebChannel } = await import("./auto-reply/monitor.js"));
});

async function captureInbound(resolverValue: ReplyPayload) {
  let captured: Parameters<ListenerFactory>[0]["onMessage"] | undefined;
  const listenerFactory: ListenerFactory = async ({ onMessage }) => {
    captured = onMessage;
    return createMockWebListener();
  };
  await monitorWebChannel(false, listenerFactory, false, vi.fn().mockResolvedValue(resolverValue));
  if (!captured) {
    throw new Error("expected WhatsApp web message handler");
  }
  return captured;
}

describe("web auto-reply media delivery", () => {
  type WebInboundPlatform = WebInboundCallbackMessage["platform"];
  type DeliverySpies = {
    [K in "reply" | "sendMedia" | "sendComposing"]: ReturnType<typeof vi.fn<WebInboundPlatform[K]>>;
  };
  const SMALL_MEDIA_CAP_MB = 0.1;
  const SMALL_MEDIA_CAP_BYTES = Math.floor(SMALL_MEDIA_CAP_MB * 1024 * 1024);

  async function setupSingleInboundMessage(params: {
    resolverValue: { text: string; mediaUrl: string };
    sendMedia?: DeliverySpies["sendMedia"];
  }) {
    const spies: DeliverySpies = createWebInboundDeliverySpies();
    const reply = spies.reply;
    const sendMedia = params.sendMedia ?? spies.sendMedia;
    const onMessage = await captureInbound(params.resolverValue);

    return {
      reply,
      sendMedia,
      dispatch: (id = "msg1", { accountId = "default" } = {}) =>
        onMessage(
          createTestWebInboundMessage({
            event: { id },
            payload: { body: "hello" },
            platform: {
              chatJid: "+1",
              recipientJid: "+2",
              sendComposing: spies.sendComposing,
              reply,
              sendMedia,
            },
            admission: {
              accountId,
              conversation: { kind: "direct", id: "+1" },
              sender: { id: "+1" },
            },
          }),
        ),
    };
  }

  function getSingleImagePayload(sendMedia: ReturnType<typeof vi.fn>) {
    expect(sendMedia).toHaveBeenCalledTimes(1);
    return sendMedia.mock.calls[0]?.[0] as {
      image: Buffer;
      caption?: string;
      mimetype?: string;
      document?: Buffer;
      fileName?: string;
    };
  }

  function mockFetchMediaBuffer(buffer: Buffer, mime: string) {
    return vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async () => new Response(Uint8Array.from(buffer), { headers: { "content-type": mime } }),
      );
  }

  it("prefers per-account WhatsApp media caps for outbound auto-replies", async () => {
    const bigPng = createNoisyPngBuffer(256, 256);
    expect(bigPng.length).toBeGreaterThan(SMALL_MEDIA_CAP_BYTES);

    setLoadConfigMock(() => ({
      channels: {
        whatsapp: {
          allowFrom: ["*"],
          mediaMaxMb: 1,
          accounts: { work: { mediaMaxMb: SMALL_MEDIA_CAP_MB } },
        },
      },
    }));

    try {
      const { reply, dispatch, sendMedia } = await setupSingleInboundMessage({
        resolverValue: { text: "hi", mediaUrl: "https://example.com/account-big.png" },
      });
      const fetchMock = mockFetchMediaBuffer(bigPng, "image/png");

      await dispatch("msg-account-cap", { accountId: "work" });

      const payload = getSingleImagePayload(sendMedia);
      expect(payload.image.length).toBeLessThanOrEqual(SMALL_MEDIA_CAP_BYTES);
      expect(payload.mimetype).toBe("image/jpeg");
      expect(reply).not.toHaveBeenCalled();
      fetchMock.mockRestore();
    } finally {
      resetLoadConfigMock();
    }
  });
  it("sends PDF media as a document", async () => {
    const { reply, dispatch, sendMedia } = await setupSingleInboundMessage({
      resolverValue: { text: "hi", mediaUrl: "https://example.com/file.pdf" },
    });

    const fetchMock = mockFetchMediaBuffer(Buffer.from("%PDF-1.4"), "application/pdf");

    await dispatch("msg-pdf");

    expect(getSingleImagePayload(sendMedia)).toMatchObject({
      document: expect.any(Buffer),
      fileName: "file.pdf",
      caption: "hi",
    });
    expect(reply).not.toHaveBeenCalled();

    fetchMock.mockRestore();
  });

  it("falls back to text when media send fails", async () => {
    const sendMedia = vi.fn<WebInboundPlatform["sendMedia"]>().mockRejectedValue(new Error("boom"));
    const { reply, dispatch } = await setupSingleInboundMessage({
      resolverValue: { text: "hi", mediaUrl: "https://example.com/img.png" },
      sendMedia,
    });

    const smallPng = createSolidPngBuffer(64, 64, { r: 0, g: 255, b: 0 });
    const fetchMock = mockFetchMediaBuffer(smallPng, "image/png");

    await dispatch("msg1");

    expect(sendMedia).toHaveBeenCalledTimes(1);
    const fallback = reply.mock.calls[0]?.[0];
    expect(fallback).toBeTypeOf("string");
    expect(fallback).toContain("hi");
    expect(fallback).toContain("Media failed");
    fetchMock.mockRestore();
  });
});

describe("web auto-reply terminal failure delivery", () => {
  const TERMINAL_FAILURE_TEXT = "⚠️ The model ended this turn without answering.";
  const SELF_JID = "123@s.whatsapp.net";

  async function startMonitorWithTerminalFailure() {
    const spies = createWebInboundDeliverySpies();
    const onMessage = await captureInbound({ text: TERMINAL_FAILURE_TEXT, isError: true });
    return { spies, onMessage };
  }

  it.each(["direct", "group"] as const)(
    "sends a terminal failure final to a %s chat",
    async (kind) => {
      const { spies, onMessage } = await startMonitorWithTerminalFailure();
      const inbound = { onMessage, spies, body: "hello" };
      if (kind === "direct") {
        await sendWebDirectInboundMessage({
          ...inbound,
          id: "direct-terminal-failure",
          from: "+1000",
          to: "+2000",
        });
      } else {
        await sendWebGroupInboundMessage({
          ...inbound,
          id: "group-terminal-failure",
          senderE164: "+1000",
          senderName: "Tester",
          selfE164: "+2000",
          selfJid: SELF_JID,
          mentionedJids: [SELF_JID],
        });
      }
      expect(spies.reply).toHaveBeenCalledTimes(1);
      const sentText = spies.reply.mock.calls[0]?.[0];
      expect(sentText).toContain(TERMINAL_FAILURE_TEXT);
      // Preserve the terminal reason instead of core's generic no-visible-reply fallback.
      expect(sentText).not.toContain("No reply was generated");
    },
  );
});
