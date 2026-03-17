import crypto from "node:crypto";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { monitorWebChannel } from "./auto-reply.js";
import {
  createMockWebListener,
  installWebAutoReplyTestHomeHooks,
  installWebAutoReplyUnitTestHooks,
  resetLoadConfigMock,
  setLoadConfigMock
} from "./auto-reply.test-harness.js";
installWebAutoReplyTestHomeHooks();
describe("web auto-reply", () => {
  installWebAutoReplyUnitTestHooks({ pinDns: true });
  const SMALL_MEDIA_CAP_MB = 0.1;
  const SMALL_MEDIA_CAP_BYTES = Math.floor(SMALL_MEDIA_CAP_MB * 1024 * 1024);
  async function setupSingleInboundMessage(params) {
    const reply = params.reply ?? vi.fn().mockResolvedValue(void 0);
    const sendComposing = vi.fn(async () => void 0);
    const resolver = vi.fn().mockResolvedValue(params.resolverValue);
    let capturedOnMessage;
    const listenerFactory = async ({ onMessage }) => {
      capturedOnMessage = onMessage;
      return createMockWebListener();
    };
    await monitorWebChannel(false, listenerFactory, false, resolver);
    expect(capturedOnMessage).toBeDefined();
    return {
      reply,
      dispatch: async (id = "msg1", overrides) => {
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
          sendMedia: params.sendMedia
        });
      }
    };
  }
  function getSingleImagePayload(sendMedia) {
    expect(sendMedia).toHaveBeenCalledTimes(1);
    return sendMedia.mock.calls[0][0];
  }
  async function withMediaCap(mediaMaxMb, run) {
    setLoadConfigMock(() => ({
      channels: {
        whatsapp: {
          allowFrom: ["*"],
          mediaMaxMb
        }
      }
    }));
    try {
      return await run();
    } finally {
      resetLoadConfigMock();
    }
  }
  function mockFetchMediaBuffer(buffer, mime) {
    return vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      body: true,
      arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
      headers: { get: () => mime },
      status: 200
    });
  }
  async function expectCompressedImageWithinCap(params) {
    await withMediaCap(params.mediaMaxMb ?? 1, async () => {
      const sendMedia = vi.fn();
      const { reply, dispatch } = await setupSingleInboundMessage({
        resolverValue: { text: "hi", mediaUrl: params.mediaUrl },
        sendMedia
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
        make: (buf, opts) => sharp(buf, {
          raw: { width: opts.width, height: opts.height, channels: 3 }
        }).png({ compressionLevel: 0 }).toBuffer()
      },
      {
        name: "jpeg",
        mime: "image/jpeg",
        make: (buf, opts) => sharp(buf, {
          raw: { width: opts.width, height: opts.height, channels: 3 }
        }).jpeg({ quality: 100, chromaSubsampling: "4:4:4" }).toBuffer()
      },
      {
        name: "webp",
        mime: "image/webp",
        make: (buf, opts) => sharp(buf, {
          raw: { width: opts.width, height: opts.height, channels: 3 }
        }).webp({ quality: 100 }).toBuffer()
      }
    ];
    const width = 320;
    const height = 320;
    const sharedRaw = crypto.randomBytes(width * height * 3);
    const renderedFormats = await Promise.all(
      formats.map(async (fmt) => ({
        ...fmt,
        image: await fmt.make(sharedRaw, { width, height })
      }))
    );
    await withMediaCap(SMALL_MEDIA_CAP_MB, async () => {
      const sendMedia = vi.fn();
      const { reply, dispatch } = await setupSingleInboundMessage({
        resolverValue: {
          text: "hi",
          mediaUrl: "https://example.com/big.image"
        },
        sendMedia
      });
      let fetchIndex = 0;
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        const matched = renderedFormats[Math.min(fetchIndex, renderedFormats.length - 1)] ?? renderedFormats[0];
        fetchIndex += 1;
        const { image, mime } = matched;
        return {
          ok: true,
          body: true,
          arrayBuffer: async () => image.buffer.slice(image.byteOffset, image.byteOffset + image.byteLength),
          headers: { get: () => mime },
          status: 200
        };
      });
      try {
        for (const [index, fmt] of renderedFormats.entries()) {
          expect(fmt.image.length).toBeGreaterThan(SMALL_MEDIA_CAP_BYTES);
          const beforeCalls = sendMedia.mock.calls.length;
          await dispatch(`msg-${fmt.name}-${index}`, {
            from: `+1${index}`,
            conversationId: `conv-${index}`,
            chatId: `conv-${index}`
          });
          expect(sendMedia).toHaveBeenCalledTimes(beforeCalls + 1);
          const payload = sendMedia.mock.calls[beforeCalls]?.[0];
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
    const bigPng = await sharp({
      create: {
        width: 256,
        height: 256,
        channels: 3,
        background: { r: 0, g: 0, b: 255 }
      }
    }).png({ compressionLevel: 0 }).toBuffer();
    expect(bigPng.length).toBeGreaterThan(SMALL_MEDIA_CAP_BYTES);
    await expectCompressedImageWithinCap({
      mediaUrl: "https://example.com/big.png",
      mime: "image/png",
      image: bigPng,
      messageId: "msg1",
      mediaMaxMb: SMALL_MEDIA_CAP_MB
    });
  });
  it("prefers per-account WhatsApp media caps for outbound auto-replies", async () => {
    const bigPng = await sharp({
      create: {
        width: 256,
        height: 256,
        channels: 3,
        background: { r: 255, g: 0, b: 0 }
      }
    }).png({ compressionLevel: 0 }).toBuffer();
    expect(bigPng.length).toBeGreaterThan(SMALL_MEDIA_CAP_BYTES);
    setLoadConfigMock(() => ({
      channels: {
        whatsapp: {
          allowFrom: ["*"],
          mediaMaxMb: 1,
          accounts: {
            work: {
              mediaMaxMb: SMALL_MEDIA_CAP_MB
            }
          }
        }
      }
    }));
    try {
      const sendMedia = vi.fn();
      const { reply, dispatch } = await setupSingleInboundMessage({
        resolverValue: { text: "hi", mediaUrl: "https://example.com/account-big.png" },
        sendMedia
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
      sendMedia
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      body: true,
      arrayBuffer: async () => Buffer.from("%PDF-1.4").buffer,
      headers: { get: () => "application/pdf" },
      status: 200
    });
    await dispatch("msg-pdf");
    expect(sendMedia).toHaveBeenCalledTimes(1);
    const payload = sendMedia.mock.calls[0][0];
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
        mediaUrl: "https://example.com/img.png"
      },
      sendMedia
    });
    const smallPng = await sharp({
      create: {
        width: 64,
        height: 64,
        channels: 3,
        background: { r: 0, g: 255, b: 0 }
      }
    }).png().toBuffer();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      body: true,
      arrayBuffer: async () => smallPng.buffer.slice(smallPng.byteOffset, smallPng.byteOffset + smallPng.byteLength),
      headers: { get: () => "image/png" },
      status: 200
    });
    await dispatch("msg1");
    expect(sendMedia).toHaveBeenCalledTimes(1);
    const fallback = reply.mock.calls[0]?.[0];
    expect(fallback).toContain("hi");
    expect(fallback).toContain("Media failed");
    fetchMock.mockRestore();
  });
  it("returns a warning when remote media fetch 404s", async () => {
    const sendMedia = vi.fn();
    const { reply, dispatch } = await setupSingleInboundMessage({
      resolverValue: {
        text: "caption",
        mediaUrl: "https://example.com/missing.jpg"
      },
      sendMedia
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 404,
      body: null,
      arrayBuffer: async () => new ArrayBuffer(0),
      headers: { get: () => "text/plain" }
    });
    await dispatch("msg1");
    expect(sendMedia).not.toHaveBeenCalled();
    const fallback = reply.mock.calls[0]?.[0];
    expect(fallback).toContain("caption");
    expect(fallback).toContain("Media failed");
    expect(fallback).toContain("404");
    fetchMock.mockRestore();
  });
  it("sends media with a caption when delivery succeeds", async () => {
    const sendMedia = vi.fn().mockResolvedValue(void 0);
    const { reply, dispatch } = await setupSingleInboundMessage({
      resolverValue: {
        text: "hi",
        mediaUrl: "https://example.com/img.png"
      },
      sendMedia
    });
    const png = await sharp({
      create: {
        width: 64,
        height: 64,
        channels: 3,
        background: { r: 0, g: 0, b: 255 }
      }
    }).png().toBuffer();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      body: true,
      arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
      headers: { get: () => "image/png" },
      status: 200
    });
    await dispatch("msg1");
    const payload = getSingleImagePayload(sendMedia);
    expect(payload.caption).toBe("hi");
    expect(payload.image.length).toBeGreaterThan(0);
    expect(reply).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });
});
