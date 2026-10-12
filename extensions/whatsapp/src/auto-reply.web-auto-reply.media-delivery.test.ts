// WhatsApp web auto-reply media and terminal failure delivery behavior.
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

let monitorWebChannel: typeof import("./auto-reply/monitor.js").monitorWebChannel;

describe("web auto-reply media delivery", () => {
  installWebAutoReplyUnitTestHooks({ pinDns: true });
  type ListenerFactory = NonNullable<Parameters<typeof monitorWebChannel>[1]>;
  type WebInboundPlatform = WebInboundCallbackMessage["platform"];
  type ReplyMock = ReturnType<typeof vi.fn<WebInboundPlatform["reply"]>>;
  type SendMediaMock = ReturnType<typeof vi.fn<WebInboundPlatform["sendMedia"]>>;
  type SendComposingMock = ReturnType<typeof vi.fn<WebInboundPlatform["sendComposing"]>>;
  const SMALL_MEDIA_CAP_MB = 0.1;
  const SMALL_MEDIA_CAP_BYTES = Math.floor(SMALL_MEDIA_CAP_MB * 1024 * 1024);

  beforeAll(async () => {
    ({ monitorWebChannel } = await import("./auto-reply/monitor.js"));
  });

  async function setupSingleInboundMessage(params: {
    resolverValue: { text: string; mediaUrl: string };
    sendMedia?: SendMediaMock;
    reply?: ReplyMock;
  }) {
    const spies = createWebInboundDeliverySpies() as {
      sendMedia: SendMediaMock;
      reply: ReplyMock;
      sendComposing: SendComposingMock;
    };
    const reply = params.reply ?? spies.reply;
    const sendMedia = params.sendMedia ?? spies.sendMedia;
    const resolver = vi.fn().mockResolvedValue(params.resolverValue);

    let capturedOnMessage: Parameters<ListenerFactory>[0]["onMessage"] | undefined;
    const listenerFactory: ListenerFactory = async ({ onMessage }) => {
      capturedOnMessage = onMessage;
      return createMockWebListener();
    };

    await monitorWebChannel(false, listenerFactory, false, resolver);
    if (!capturedOnMessage) {
      throw new Error("expected WhatsApp web message handler");
    }
    const onMessage = capturedOnMessage;

    return {
      reply,
      sendMedia,
      dispatch: async (
        id = "msg1",
        overrides?: Partial<{
          from: string;
          conversationId: string;
          accountId: string;
          recipientJid: string;
          chatJid: string;
        }>,
      ) => {
        const from = overrides?.from ?? "+1";
        const conversationId = overrides?.conversationId ?? from;
        const chatJid = overrides?.chatJid ?? from;
        await onMessage(
          createTestWebInboundMessage({
            event: {
              id,
            },
            payload: {
              body: "hello",
            },
            platform: {
              chatJid,
              recipientJid: overrides?.recipientJid ?? "+2",
              sendComposing: spies.sendComposing,
              reply,
              sendMedia,
            },
            admission: {
              accountId: overrides?.accountId ?? "default",
              conversation: {
                kind: "direct",
                id: conversationId,
              },
              sender: {
                id: from,
              },
            },
          }),
        );
      },
    };
  }

  function getSingleImagePayload(sendMedia: ReturnType<typeof vi.fn>) {
    expect(sendMedia).toHaveBeenCalledTimes(1);
    return imagePayloadAt(sendMedia, 0);
  }

  function imagePayloadAt(sendMedia: ReturnType<typeof vi.fn>, callIndex: number) {
    const call = sendMedia.mock.calls.at(callIndex);
    if (!call) {
      throw new Error(`Expected sendMedia call ${callIndex}`);
    }
    return call[0] as {
      image: Buffer;
      caption?: string;
      mimetype?: string;
    };
  }

  function replyText(reply: ReturnType<typeof vi.fn>): string {
    const call = reply.mock.calls.at(0);
    if (!call || typeof call[0] !== "string") {
      throw new Error("Expected text reply call");
    }
    return call[0];
  }

  function fetchResponse(body: Buffer, mime: string): Response {
    return new Response(Uint8Array.from(body), {
      headers: { "content-type": mime },
    });
  }

  function mockFetchMediaBuffer(buffer: Buffer, mime: string) {
    return vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => fetchResponse(buffer, mime));
  }

  it("prefers per-account WhatsApp media caps for outbound auto-replies", async () => {
    const bigPng = createNoisyPngBuffer(256, 256);
    expect(bigPng.length).toBeGreaterThan(SMALL_MEDIA_CAP_BYTES);

    setLoadConfigMock(() => ({
      channels: {
        whatsapp: {
          allowFrom: ["*"],
          mediaMaxMb: 1,
          accounts: {
            work: {
              mediaMaxMb: SMALL_MEDIA_CAP_MB,
            },
          },
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

    expect(sendMedia).toHaveBeenCalledTimes(1);
    const payload = imagePayloadAt(sendMedia, 0) as {
      document?: Buffer;
      caption?: string;
      fileName?: string;
    };
    expect(payload.document).toBeInstanceOf(Buffer);
    expect(payload.fileName).toBe("file.pdf");
    expect(payload.caption).toBe("hi");
    expect(reply).not.toHaveBeenCalled();

    fetchMock.mockRestore();
  });

  it("falls back to text when media send fails", async () => {
    const sendMedia = vi.fn<WebInboundPlatform["sendMedia"]>().mockRejectedValue(new Error("boom"));
    const { reply, dispatch } = await setupSingleInboundMessage({
      resolverValue: {
        text: "hi",
        mediaUrl: "https://example.com/img.png",
      },
      sendMedia,
    });

    const smallPng = createSolidPngBuffer(64, 64, { r: 0, g: 255, b: 0 });
    const fetchMock = mockFetchMediaBuffer(smallPng, "image/png");

    await dispatch("msg1");

    expect(sendMedia).toHaveBeenCalledTimes(1);
    const fallback = replyText(reply);
    expect(fallback).toContain("hi");
    expect(fallback).toContain("Media failed");
    fetchMock.mockRestore();
  });
});

describe("web auto-reply terminal failure delivery", () => {
  installWebAutoReplyUnitTestHooks({ pinDns: true });
  const TERMINAL_FAILURE_TEXT = "⚠️ The model ended this turn without answering.";
  const SELF_JID = "123@s.whatsapp.net";
  type ListenerFactory = NonNullable<Parameters<typeof monitorWebChannel>[1]>;

  beforeAll(async () => {
    ({ monitorWebChannel } = await import("./auto-reply/monitor.js"));
  });

  async function startMonitorWithTerminalFailure(): Promise<{
    spies: ReturnType<typeof createWebInboundDeliverySpies>;
    onMessage: (msg: WebInboundCallbackMessage) => Promise<void>;
  }> {
    const spies = createWebInboundDeliverySpies();
    const resolver = vi.fn().mockResolvedValue({ text: TERMINAL_FAILURE_TEXT, isError: true });
    let capturedOnMessage: Parameters<ListenerFactory>[0]["onMessage"] | undefined;
    const listenerFactory: ListenerFactory = async ({ onMessage }) => {
      capturedOnMessage = onMessage;
      return createMockWebListener();
    };

    await monitorWebChannel(false, listenerFactory, false, resolver);
    if (!capturedOnMessage) {
      throw new Error("expected WhatsApp web message handler");
    }
    return { spies, onMessage: capturedOnMessage };
  }

  it("sends a terminal failure final to a direct chat", async () => {
    const { spies, onMessage } = await startMonitorWithTerminalFailure();

    await sendWebDirectInboundMessage({
      onMessage,
      spies,
      id: "direct-terminal-failure",
      from: "+1000",
      to: "+2000",
      body: "hello",
    });

    expect(spies.reply).toHaveBeenCalledTimes(1);
    const sentText = spies.reply.mock.calls[0]?.[0];
    expect(sentText).toContain(TERMINAL_FAILURE_TEXT);
    // Suppressing the terminal failure previously left core to substitute its generic
    // no-visible-reply fallback, which hides the real reason the turn ended.
    expect(sentText).not.toContain("No reply was generated");
  });

  it("sends a terminal failure final to a group chat", async () => {
    const { spies, onMessage } = await startMonitorWithTerminalFailure();

    await sendWebGroupInboundMessage({
      onMessage,
      spies,
      id: "group-terminal-failure",
      body: "hello",
      senderE164: "+1000",
      senderName: "Tester",
      selfE164: "+2000",
      selfJid: SELF_JID,
      mentionedJids: [SELF_JID],
    });

    expect(spies.reply).toHaveBeenCalledTimes(1);
    expect(spies.reply.mock.calls[0]?.[0]).toContain(TERMINAL_FAILURE_TEXT);
  });
});
