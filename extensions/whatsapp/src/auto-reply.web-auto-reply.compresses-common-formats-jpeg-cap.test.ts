import crypto from "node:crypto";
import { Transformer } from "@napi-rs/image";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  createMockWebListener,
  installWebAutoReplyTestHomeHooks,
  installWebAutoReplyUnitTestHooks,
  resetLoadConfigMock,
  setLoadConfigMock,
} from "./auto-reply.test-harness.js";
import type { WebInboundMessage } from "./inbound.js";

installWebAutoReplyTestHomeHooks();

function solidColorRgba(w: number, h: number, r: number, g: number, b: number): Buffer {
  const buf = Buffer.alloc(w * h * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = r;
    buf[i + 1] = g;
    buf[i + 2] = b;
    buf[i + 3] = 255;
  }
  return buf;
}

let monitorWebChannel: typeof import("./auto-reply.js").monitorWebChannel;

describe("web auto-reply", () => {
  installWebAutoReplyUnitTestHooks({ pinDns: true });
  type ListenerFactory = NonNullable<Parameters<typeof monitorWebChannel>[1]>;
  const SMALL_MEDIA_CAP_MB = 0.1;
  const SMALL_MEDIA_CAP_BYTES = Math.floor(SMALL_MEDIA_CAP_MB * 1024 * 1024);

  beforeAll(async () => {
    ({ monitorWebChannel } = await import("./auto-reply.js"));
  });

  async function setupSingleInboundMessage(params: {
    resolverValue: { text: string; mediaUrl: string };
    sendMedia: ReturnType<typeof vi.fn>;
    reply?: ReturnType<typeof vi.fn>;
  }) {
    const reply = params.reply ?? vi.fn().mockResolvedValue(undefined);
    const sendComposing = vi.fn(async () => undefined);
    const resolver = vi.fn().mockResolvedValue(params.resolverValue);

    let capturedOnMessage: ((msg: WebInboundMessage) => Promise<void>) | undefined;
    const listenerFactory: ListenerFactory = async ({ onMessage }) => {
      capturedOnMessage = onMessage;
      return createMockWebListener();
    };

    await monitorWebChannel(false, listenerFactory, false, resolver);
    expect(capturedOnMessage).toBeDefined();

    return {
      reply,
      dispatch: async (
        id = "msg1",
        overrides?: Partial<
          Pick<WebInboundMessage, "from" | "conversationId" | "to" | "accountId" | "chatId">
        >,
      ) => {
        await capturedOnMessage?.({
          body: "hello",
          from: "+1",
          conversationId: "+1",
          to: "+2",
          accountId: "default",
          chatType: "direct",
          chatId: "+1",
          ...overrides,
          id,
          sendComposing,
          reply,
          sendMedia: params.sendMedia,
        } as WebInboundMessage);
      },
    };
  }

  function getSingleImagePayload(sendMedia: ReturnType<typeof vi.fn>) {
    expect(sendMedia).toHaveBeenCalledTimes(1);
    return sendMedia.mock.calls[0][0] as {
      image: Buffer;
      caption?: string;
      mimetype?: string;
    };
  }

  async function withMediaCap<T>(mediaMaxMb: number, run: () => Promise<T>): Promise<T> {
    setLoadConfigMock(() => ({
      channels: {
        whatsapp: {
          allowFrom: ["*"],
          mediaMaxMb,
        },
      },
    }));
    try {
      return await run();
    } finally {
      resetLoadConfigMock();
    }
  }

  function mockFetchMediaBuffer(buffer: Buffer, mime: string) {
    return vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      body: true,
      arrayBuffer: async () =>
        buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
      headers: { get: () => mime },
      status: 200,
    } as unknown as Response);
  }

  async function expectCompressedImageWithinCap(params: {
    mediaUrl: string;
    mime: string;
    image: Buffer;
    messageId: string;
    mediaMaxMb?: number;
  }) {
    await withMediaCap(params.mediaMaxMb ?? 1, async () => {
      const sendMedia = vi.fn();
      const { reply, dispatch } = await setupSingleInboundMessage({
        resolverValue: { text: "hi", mediaUrl: params.mediaUrl },
        sendMedia,
      });
      const fetchMock = mockFetchMediaBuffer(params.image, params.mime);

      await dispatch(params.messageId);

      const payload = getSingleImagePayload(sendMedia);
      expect(payload.image.length).toBeLessThanOrEqual((params.mediaMaxMb ?? 1) * 1024 * 1024);
      expect(payload.mimetype).toBe("image/jpeg");
      expect(reply).not.toHaveBeenCalled();
      fetchMock.mockRestore();
    });
  }

  it("compresses common formats to jpeg under the cap", async () => {
    const formats = [
      {
        name: "png",
        mime: "image/png",
        make: (rgba: Buffer, opts: { width: number; height: number }) =>
          Transformer.fromRgbaPixels(rgba, opts.width, opts.height).png({ compressionType: 0 }),
      },
      {
        name: "jpeg",
        mime: "image/jpeg",
        make: (rgba: Buffer, opts: { width: number; height: number }) =>
          // Keep source > cap with fewer pixels so the test runs faster.
          Transformer.fromRgbaPixels(rgba, opts.width, opts.height).jpeg(100),
      },
      {
        name: "webp",
        mime: "image/webp",
        make: (rgba: Buffer, opts: { width: number; height: number }) =>
          Transformer.fromRgbaPixels(rgba, opts.width, opts.height).webp(100),
      },
    ] as const;

    const width = 320;
    const height = 320;
    const sharedRaw = crypto.randomBytes(width * height * 4);
    // Set all alpha channels to opaque
    for (let i = 3; i < sharedRaw.length; i += 4) sharedRaw[i] = 255;

    const renderedFormats = await Promise.all(
      formats.map(async (fmt) => ({
        ...fmt,
        image: await fmt.make(sharedRaw, { width, height }),
      })),
    );

    await withMediaCap(SMALL_MEDIA_CAP_MB, async () => {
      const sendMedia = vi.fn();
      const { reply, dispatch } = await setupSingleInboundMessage({
        resolverValue: {
          text: "hi",
          mediaUrl: "https://example.com/big.image",
        },
        sendMedia,
      });
      let fetchIndex = 0;

      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        const matched =
          renderedFormats[Math.min(fetchIndex, renderedFormats.length - 1)] ?? renderedFormats[0];
        fetchIndex += 1;
        const { image, mime } = matched;
        return {
          ok: true,
          body: true,
          arrayBuffer: async () =>
            image.buffer.slice(image.byteOffset, image.byteOffset + image.byteLength),
          headers: { get: () => mime },
          status: 200,
        } as unknown as Response;
      });

      try {
        for (const [index, fmt] of renderedFormats.entries()) {
          expect(fmt.image.length).toBeGreaterThan(SMALL_MEDIA_CAP_BYTES);
          const beforeCalls = sendMedia.mock.calls.length;
          await dispatch(`msg-${fmt.name}-${index}`, {
            from: `+1${index}`,
            conversationId: `conv-${index}`,
            chatId: `conv-${index}`,
          });
          expect(sendMedia).toHaveBeenCalledTimes(beforeCalls + 1);
          const payload = sendMedia.mock.calls[beforeCalls]?.[0] as {
            image: Buffer;
            caption?: string;
            mimetype?: string;
          };
          expect(payload.image.length).toBeLessThanOrEqual(SMALL_MEDIA_CAP_BYTES);
          expect(payload.mimetype).toBe("image/jpeg");
        }
        expect(sendMedia).toHaveBeenCalledTimes(renderedFormats.length);
        expect(reply).not.toHaveBeenCalled();
      } finally {
        fetchMock.mockRestore();
      }
    });
  });

  it("honors channels.whatsapp.mediaMaxMb for outbound auto-replies", async () => {
    const noiseRgba = crypto.randomBytes(256 * 256 * 4);
    for (let i = 3; i < noiseRgba.length; i += 4) noiseRgba[i] = 255;
    const bigPng = await Transformer.fromRgbaPixels(noiseRgba, 256, 256).png({
      compressionType: 0,
    });
    expect(bigPng.length).toBeGreaterThan(SMALL_MEDIA_CAP_BYTES);
    await expectCompressedImageWithinCap({
      mediaUrl: "https://example.com/big.png",
      mime: "image/png",
      image: bigPng,
      messageId: "msg1",
      mediaMaxMb: SMALL_MEDIA_CAP_MB,
    });
  });

  it("prefers per-account WhatsApp media caps for outbound auto-replies", async () => {
    const noiseRgba = crypto.randomBytes(256 * 256 * 4);
    for (let i = 3; i < noiseRgba.length; i += 4) noiseRgba[i] = 255;
    const bigPng = await Transformer.fromRgbaPixels(noiseRgba, 256, 256).png({
      compressionType: 0,
    });
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
      const sendMedia = vi.fn();
      const { reply, dispatch } = await setupSingleInboundMessage({
        resolverValue: { text: "hi", mediaUrl: "https://example.com/account-big.png" },
        sendMedia,
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
  it("falls back to text when media is unsupported", async () => {
    const sendMedia = vi.fn();
    const { reply, dispatch } = await setupSingleInboundMessage({
      resolverValue: { text: "hi", mediaUrl: "https://example.com/file.pdf" },
      sendMedia,
    });

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      body: true,
      arrayBuffer: async () => Buffer.from("%PDF-1.4").buffer,
      headers: { get: () => "application/pdf" },
      status: 200,
    } as unknown as Response);

    await dispatch("msg-pdf");

    expect(sendMedia).toHaveBeenCalledTimes(1);
    const payload = sendMedia.mock.calls[0][0] as {
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
    const sendMedia = vi.fn().mockRejectedValue(new Error("boom"));
    const { reply, dispatch } = await setupSingleInboundMessage({
      resolverValue: {
        text: "hi",
        mediaUrl: "https://example.com/img.png",
      },
      sendMedia,
    });

    const greenRgba = solidColorRgba(64, 64, 0, 255, 0);
    const smallPng = await Transformer.fromRgbaPixels(greenRgba, 64, 64).png();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      body: true,
      arrayBuffer: async () =>
        smallPng.buffer.slice(smallPng.byteOffset, smallPng.byteOffset + smallPng.byteLength),
      headers: { get: () => "image/png" },
      status: 200,
    } as unknown as Response);

    await dispatch("msg1");

    expect(sendMedia).toHaveBeenCalledTimes(1);
    const fallback = reply.mock.calls[0]?.[0] as string;
    expect(fallback).toContain("hi");
    expect(fallback).toContain("Media failed");
    fetchMock.mockRestore();
  });
  it("returns a warning when remote media fetch 404s", async () => {
    const sendMedia = vi.fn();
    const { reply, dispatch } = await setupSingleInboundMessage({
      resolverValue: {
        text: "caption",
        mediaUrl: "https://example.com/missing.jpg",
      },
      sendMedia,
    });

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 404,
      body: null,
      arrayBuffer: async () => new ArrayBuffer(0),
      headers: { get: () => "text/plain" },
    } as unknown as Response);

    await dispatch("msg1");

    expect(sendMedia).not.toHaveBeenCalled();
    const fallback = reply.mock.calls[0]?.[0] as string;
    expect(fallback).toContain("caption");
    expect(fallback).toContain("Media failed");
    expect(fallback).toContain("404");

    fetchMock.mockRestore();
  });
  it("sends media with a caption when delivery succeeds", async () => {
    const sendMedia = vi.fn().mockResolvedValue(undefined);
    const { reply, dispatch } = await setupSingleInboundMessage({
      resolverValue: {
        text: "hi",
        mediaUrl: "https://example.com/img.png",
      },
      sendMedia,
    });

    const pngRgba = solidColorRgba(64, 64, 0, 0, 255);
    const png = await Transformer.fromRgbaPixels(pngRgba, 64, 64).png();

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      body: true,
      arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
      headers: { get: () => "image/png" },
      status: 200,
    } as unknown as Response);

    await dispatch("msg1");

    const payload = getSingleImagePayload(sendMedia);
    expect(payload.caption).toBe("hi");
    expect(payload.image.length).toBeGreaterThan(0);
    // Should not fall back to separate text reply because caption is used.
    expect(reply).not.toHaveBeenCalled();

    fetchMock.mockRestore();
  });
});
