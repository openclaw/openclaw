// Whatsapp tests cover send plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAcceptedWhatsAppSendResult } from "./inbound/send-result.test-helper.js";
import type { ActiveWebListener } from "./inbound/types.js";

const hoisted = vi.hoisted(() => ({
  loadOutboundMediaFromUrl: vi.fn(),
  controllerListeners: new Map<string, ActiveWebListener>(),
  getPNForLID: vi.fn<() => Promise<string | null>>(async () => null),
  transcodeAudioBufferToOpus: vi.fn(),
}));
const loadWebMediaMock = vi.fn();
let sendMessageWhatsApp: typeof import("./send.js").sendMessageWhatsApp;
let sendPollWhatsApp: typeof import("./send.js").sendPollWhatsApp;
let sendReactionWhatsApp: typeof import("./send.js").sendReactionWhatsApp;
let sendTypingWhatsApp: typeof import("./send.js").sendTypingWhatsApp;

const WHATSAPP_TEST_CFG: OpenClawConfig = { channels: { whatsapp: {} } };

vi.mock("./connection-controller-runtime-context.js", async () => {
  const actual = await vi.importActual<typeof import("./connection-controller-runtime-context.js")>(
    "./connection-controller-runtime-context.js",
  );
  return {
    ...actual,
    getWhatsAppConnectionController: vi.fn((accountId: string) => {
      const listener = hoisted.controllerListeners.get(accountId) ?? null;
      return listener
        ? {
            getActiveListener: () => listener,
            getCurrentSock: () => ({
              signalRepository: { lidMapping: { getPNForLID: hoisted.getPNForLID } },
            }),
          }
        : null;
    }),
  };
});

vi.mock("openclaw/plugin-sdk/outbound-media", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/outbound-media")>(
    "openclaw/plugin-sdk/outbound-media",
  );
  return {
    ...actual,
    loadOutboundMediaFromUrl: hoisted.loadOutboundMediaFromUrl,
  };
});

vi.mock("openclaw/plugin-sdk/media-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/media-runtime")>(
    "openclaw/plugin-sdk/media-runtime",
  );
  return {
    ...actual,
    transcodeAudioBufferToOpus: hoisted.transcodeAudioBufferToOpus,
  };
});

function sendOptions(overrides: Partial<Parameters<typeof sendMessageWhatsApp>[2]> = {}) {
  return { verbose: false, cfg: WHATSAPP_TEST_CFG, ...overrides };
}

function sendText(body: string, overrides: Parameters<typeof sendOptions>[0] = {}) {
  return sendMessageWhatsApp("+1555", body, sendOptions(overrides));
}

describe("web outbound", () => {
  const sendComposingTo = vi.fn(async () => {});
  const sendMessage = vi.fn(async () => createAcceptedWhatsAppSendResult("text", "msg123"));
  const sendPoll = vi.fn(async () => createAcceptedWhatsAppSendResult("poll", "poll123"));
  const sendReaction = vi.fn(async () =>
    createAcceptedWhatsAppSendResult("reaction", "reaction123"),
  );

  function listener(overrides: Partial<ActiveWebListener> = {}) {
    return { sendComposingTo, sendMessage, sendPoll, sendReaction, ...overrides };
  }
  function rejectReachout() {
    const assertSendReady = vi.fn(async () => {
      throw new Error("WhatsApp reachout timelock is active");
    });
    hoisted.controllerListeners.set("default", listener({ assertSendReady }));
    return assertSendReady;
  }
  function media(buffer: Buffer, contentType: string, kind: string, fileName?: string) {
    loadWebMediaMock.mockResolvedValueOnce({
      buffer,
      contentType,
      kind,
      ...(fileName ? { fileName } : {}),
    });
  }

  beforeAll(async () => {
    ({ sendMessageWhatsApp, sendPollWhatsApp, sendReactionWhatsApp, sendTypingWhatsApp } =
      await import("./send.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.getPNForLID.mockReset().mockResolvedValue(null);
    hoisted.transcodeAudioBufferToOpus.mockReset().mockResolvedValue(Buffer.from("opus-output"));
    hoisted.loadOutboundMediaFromUrl.mockReset().mockImplementation(
      async (
        mediaUrl: string,
        options?: {
          maxBytes?: number;
          mediaAccess?: {
            localRoots?: readonly string[];
            readFile?: (filePath: string) => Promise<Buffer>;
          };
          mediaLocalRoots?: readonly string[];
          mediaReadFile?: (filePath: string) => Promise<Buffer>;
          optimizeImages?: boolean;
        },
      ) =>
        await loadWebMediaMock(mediaUrl, {
          maxBytes: options?.maxBytes,
          localRoots: options?.mediaAccess?.localRoots ?? options?.mediaLocalRoots,
          readFile: options?.mediaAccess?.readFile ?? options?.mediaReadFile,
          hostReadCapability: Boolean(options?.mediaAccess?.readFile ?? options?.mediaReadFile),
        }),
    );
    hoisted.controllerListeners.clear();
    hoisted.controllerListeners.set("default", listener());
  });

  afterEach(() => {
    hoisted.controllerListeners.clear();
  });

  it("delivers an image without alt text instead of reporting an unsent success", async () => {
    await expect(sendText("![](https://example.com/diagram.png)")).resolves.toEqual({
      messageId: "msg123",
      toJid: "1555@s.whatsapp.net",
    });
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith(
      "+1555",
      "![](https://example.com/diagram.png)",
      undefined,
      undefined,
    );
  });

  it("rejects provider-unaccepted voice sends without synthetic delivery progress", async () => {
    media(Buffer.from("voice"), "audio/ogg", "audio");
    sendMessage.mockResolvedValueOnce({
      kind: "media",
      messageId: "unknown",
      keys: [],
      providerAccepted: false,
    });
    const onDeliveryResult = vi.fn();
    await expect(
      sendText("hello", { mediaUrl: "/tmp/voice.ogg", onDeliveryResult }),
    ).rejects.toBeInstanceOf(PlatformMessageNotDispatchedError);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(onDeliveryResult).not.toHaveBeenCalled();
  });

  it("still sends when composing presence fails", async () => {
    sendComposingTo.mockRejectedValueOnce(new Error("presence update unavailable"));

    await expect(sendText("hi")).resolves.toEqual({
      messageId: "msg123",
      toJid: "1555@s.whatsapp.net",
    });
    expect(sendComposingTo).toHaveBeenCalledWith("+1555");
    expect(sendMessage).toHaveBeenCalledWith("+1555", "hi", undefined, undefined);
  });

  it("re-chunks after WhatsApp marker expansion", async () => {
    const onDeliveryResult = vi.fn();
    await sendText(Array.from({ length: 8 }, () => "`x`").join(" "), {
      cfg: { channels: { whatsapp: { textChunkLimit: 20 } } },
      onDeliveryResult,
    });

    const sentText = (sendMessage.mock.calls as unknown as Array<[string, string]>).map(
      ([, chunk]) => chunk,
    );
    expect(sentText.length).toBeGreaterThan(1);
    expect(sentText.every((chunk) => chunk.length <= 20)).toBe(true);
    expect(sentText.join("")).not.toContain("\uE000");
    expect(onDeliveryResult).toHaveBeenCalledTimes(sentText.length);
  });

  it("checks send readiness before composing or sending direct messages", async () => {
    const assertSendReady = rejectReachout();

    await expect(sendText("hi")).rejects.toThrow("WhatsApp reachout timelock is active");

    expect(assertSendReady).toHaveBeenCalledWith("+1555");
    expect(sendComposingTo).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("returns the actual outbound key remote JID when Baileys resolves a LID target", async () => {
    sendMessage.mockResolvedValueOnce({
      kind: "text",
      messageId: "msg-lid",
      keys: [{ id: "msg-lid", remoteJid: "123456789@lid", fromMe: true }],
      providerAccepted: true,
    });

    const result = await sendText("hi");

    expect(result).toEqual({ messageId: "msg-lid", toJid: "123456789@lid" });
  });

  it("reports the phone chat identity for a delivered LID text reply", async () => {
    hoisted.getPNForLID.mockResolvedValue("1555@s.whatsapp.net");
    sendMessage.mockResolvedValueOnce({
      kind: "text",
      messageId: "mapped-lid-reply",
      keys: [{ id: "mapped-lid-reply", remoteJid: "123456789@lid", fromMe: true }],
      providerAccepted: true,
    });

    await expect(sendText("Report")).resolves.toEqual({
      messageId: "mapped-lid-reply",
      toJid: "1555@s.whatsapp.net",
    });
  });

  it("preserves intentional indentation when the caller opts out of transport trimming", async () => {
    await sendText("    indented", { preserveLeadingWhitespace: true });

    expect(sendMessage).toHaveBeenLastCalledWith("+1555", "    indented", undefined, undefined);
  });

  it("skips whitespace-only text sends without media", async () => {
    const result = await sendText("\n \t");

    expect(result).toEqual({ messageId: "", toJid: "1555@s.whatsapp.net" });
    expect(sendComposingTo).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("checks send readiness before standalone direct typing", async () => {
    const assertSendReady = rejectReachout();

    await expect(sendTypingWhatsApp("+1555", { cfg: WHATSAPP_TEST_CFG })).rejects.toThrow(
      "WhatsApp reachout timelock is active",
    );

    expect(assertSendReady).toHaveBeenCalledWith("+1555");
    expect(sendComposingTo).not.toHaveBeenCalled();
  });

  it("throws a helpful error when no active listener exists", async () => {
    hoisted.controllerListeners.clear();
    const error = await sendText("hi", { accountId: "work" }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(PlatformMessageNotDispatchedError);
    expect(error).toMatchObject({
      code: "OPENCLAW_PLATFORM_MESSAGE_NOT_DISPATCHED",
      message: expect.stringMatching(
        /No active WhatsApp Web listener.*channels login.*account work/,
      ),
    });
  });

  it("does not retry transient outbound send failures to avoid duplicate sends", async () => {
    sendMessage.mockRejectedValueOnce({ error: { message: "connection closed" } });

    await expect(sendText("hi")).rejects.toEqual({ error: { message: "connection closed" } });
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("marks gif playback for video when requested", async () => {
    const buf = Buffer.from("gifvid");
    media(buf, "video/mp4", "video");
    await sendText("gif", { mediaUrl: "/tmp/anim.mp4", gifPlayback: true });
    expect(sendMessage).toHaveBeenLastCalledWith("+1555", "gif", buf, "video/mp4", {
      gifPlayback: true,
    });
  });

  it("infers opaque image uploads from the requested filename", async () => {
    const buffer = Buffer.from("attachment");
    const mediaReadFile = vi.fn(async () => buffer);
    media(buffer, "application/octet-stream", "document", "blob");
    await sendMessageWhatsApp(
      "+1555",
      "attachment",
      sendOptions({
        mediaUrl: "https://example.com/blob",
        fileName: "Receipt.png",
        forceDocument: true,
        mediaLocalRoots: ["/tmp/approved"],
        mediaReadFile,
      }),
    );
    expect(loadWebMediaMock).toHaveBeenCalledWith("https://example.com/blob", {
      maxBytes: 50 * 1024 * 1024,
      localRoots: ["/tmp/approved"],
      readFile: mediaReadFile,
      hostReadCapability: true,
    });
    expect(sendMessage).toHaveBeenLastCalledWith("+1555", "attachment", buffer, "image/png", {
      asDocument: true,
      fileName: "Receipt.png",
    });
  });

  it("uses explicit upload MIME metadata to deliver a remote PDF as a document", async () => {
    const buffer = Buffer.from("attachment");
    media(buffer, "application/octet-stream", "document", "download.bin");
    await sendMessageWhatsApp(
      "+1555",
      "attachment",
      sendOptions({
        mediaUrl: "https://example.com/opaque-document",
        contentType: "application/pdf",
        fileName: "report.pdf",
      }),
    );
    expect(sendMessage).toHaveBeenLastCalledWith("+1555", "attachment", buffer, "application/pdf", {
      fileName: "report.pdf",
    });
  });

  it("keeps explicit document delivery for prehydrated video payloads", async () => {
    const buf = Buffer.from("visual-as-document");
    await sendText("doc", {
      mediaPayload: {
        buffer: buf,
        contentType: "video/mp4",
        fileName: "clip.mp4",
        kind: "document",
      },
    });
    expect(sendMessage).toHaveBeenLastCalledWith("+1555", "doc", buf, "video/mp4", {
      asDocument: true,
      fileName: "clip.mp4",
    });
  });

  it("maps documents without fileName to MIME-aware default filename", async () => {
    const buf = Buffer.from("pdf");
    media(buf, "application/pdf", "document");
    await sendText("doc", { mediaUrl: "media://generated" });
    expect(sendMessage).toHaveBeenLastCalledWith("+1555", "doc", buf, "application/pdf", {
      fileName: "file.pdf",
    });
  });

  it("forces document branch when forceDocument is true with video media", async () => {
    const buf = Buffer.from("video");
    media(buf, "video/mp4", "video", "clip.mp4");
    await sendText("watch", { mediaUrl: "/tmp/clip.mp4", forceDocument: true });
    expect(sendMessage).toHaveBeenLastCalledWith("+1555", "watch", buf, "video/mp4", {
      asDocument: true,
      fileName: "clip.mp4",
    });
  });

  it("uses account-aware WhatsApp media caps for outbound uploads", async () => {
    hoisted.controllerListeners.set("work", listener());
    media(Buffer.from("img"), "image/jpeg", "image");

    const cfg: OpenClawConfig = {
      channels: { whatsapp: { mediaMaxMb: 25, accounts: { work: { mediaMaxMb: 100 } } } },
    };

    await sendText("pic", {
      accountId: "work",
      cfg,
      mediaUrl: "/tmp/pic.jpg",
      mediaLocalRoots: ["/tmp/workspace"],
    });

    expect(loadWebMediaMock).toHaveBeenCalledWith("/tmp/pic.jpg", {
      maxBytes: 100 * 1024 * 1024,
      localRoots: ["/tmp/workspace"],
      readFile: undefined,
      hostReadCapability: false,
    });
  });

  it("rejects polls without an accepted provider message key", async () => {
    sendPoll.mockResolvedValueOnce({
      kind: "poll",
      messageId: "unknown",
      keys: [],
      providerAccepted: false,
    });

    await expect(
      sendPollWhatsApp("+1555", { question: "Lunch?", options: ["Pizza", "Sushi"] }, sendOptions()),
    ).rejects.toBeInstanceOf(PlatformMessageNotDispatchedError);

    expect(sendPoll).toHaveBeenCalledOnce();
  });

  it("checks send readiness before sending direct polls", async () => {
    const assertSendReady = rejectReachout();

    await expect(
      sendPollWhatsApp("+1555", { question: "Lunch?", options: ["Pizza", "Sushi"] }, sendOptions()),
    ).rejects.toThrow("WhatsApp reachout timelock is active");

    expect(assertSendReady).toHaveBeenCalledWith("+1555");
    expect(sendPoll).not.toHaveBeenCalled();
  });

  it("sends reactions via active listener", async () => {
    await sendReactionWhatsApp("1555@s.whatsapp.net", "msg123", "✅", {
      ...sendOptions(),
      fromMe: false,
    });
    expect(sendReaction).toHaveBeenCalledWith(
      "1555@s.whatsapp.net",
      "msg123",
      "✅",
      false,
      undefined,
    );
  });
});
