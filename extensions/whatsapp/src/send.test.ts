// Whatsapp tests cover send plugin behavior.
import crypto from "node:crypto";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as waitForLogTick } from "node:timers/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { redactIdentifier } from "openclaw/plugin-sdk/logging-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAcceptedWhatsAppSendResult } from "./inbound/send-result.test-helper.js";
import type { ActiveWebListener } from "./inbound/types.js";

const hoisted = vi.hoisted(() => ({
  loadOutboundMediaFromUrl: vi.fn(),
  controllerListeners: new Map<string, ActiveWebListener>(),
  transcodeAudioBufferToOpus: vi.fn(),
}));
const loadWebMediaMock = vi.fn();
let sendMessageWhatsApp: typeof import("./send.js").sendMessageWhatsApp;
let sendWhatsAppUploadFile: typeof import("./send.js").sendWhatsAppUploadFile;
let sendPollWhatsApp: typeof import("./send.js").sendPollWhatsApp;
let sendReactionWhatsApp: typeof import("./send.js").sendReactionWhatsApp;
let sendTypingWhatsApp: typeof import("./send.js").sendTypingWhatsApp;
let resetLogger: typeof import("openclaw/plugin-sdk/runtime-env").resetLogger;
let setLoggerOverride: typeof import("openclaw/plugin-sdk/runtime-env").setLoggerOverride;

const WHATSAPP_TEST_CFG: OpenClawConfig = {
  channels: { whatsapp: {} },
};

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

describe("web outbound", () => {
  const sendComposingTo = vi.fn(async () => {});
  const sendMessage = vi.fn(async () => createAcceptedWhatsAppSendResult("text", "msg123"));
  const sendPoll = vi.fn(async () => createAcceptedWhatsAppSendResult("poll", "poll123"));
  const sendReaction = vi.fn(async () =>
    createAcceptedWhatsAppSendResult("reaction", "reaction123"),
  );

  beforeAll(async () => {
    ({
      sendMessageWhatsApp,
      sendWhatsAppUploadFile,
      sendPollWhatsApp,
      sendReactionWhatsApp,
      sendTypingWhatsApp,
    } = await import("./send.js"));
    const { resetLogger: loadedResetLogger, setLoggerOverride: loadedSetLoggerOverride } =
      await import("openclaw/plugin-sdk/runtime-env");
    resetLogger = loadedResetLogger;
    setLoggerOverride = loadedSetLoggerOverride;
  });

  beforeEach(() => {
    vi.clearAllMocks();
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
    hoisted.controllerListeners.set("default", {
      sendComposingTo,
      sendMessage,
      sendPoll,
      sendReaction,
    });
  });

  afterEach(() => {
    resetLogger();
    setLoggerOverride(null);
    hoisted.controllerListeners.clear();
  });

  it("delivers an image without alt text instead of reporting an unsent success", async () => {
    await expect(
      sendMessageWhatsApp("+1555", "![](https://example.com/diagram.png)", {
        verbose: false,
        cfg: WHATSAPP_TEST_CFG,
      }),
    ).resolves.toEqual({ messageId: "msg123", toJid: "1555@s.whatsapp.net" });
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith(
      "+1555",
      "![](https://example.com/diagram.png)",
      undefined,
      undefined,
    );
  });

  it("rejects provider-unaccepted voice sends without synthetic delivery progress", async () => {
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.from("voice"),
      contentType: "audio/ogg",
      kind: "audio",
    });
    sendMessage.mockResolvedValueOnce({
      kind: "media",
      messageId: "unknown",
      keys: [],
      providerAccepted: false,
    });
    const onDeliveryResult = vi.fn();
    await expect(
      sendMessageWhatsApp("+1555", "hello", {
        verbose: false,
        cfg: WHATSAPP_TEST_CFG,
        mediaUrl: "/tmp/voice.ogg",
        onDeliveryResult,
      }),
    ).rejects.toBeInstanceOf(PlatformMessageNotDispatchedError);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(onDeliveryResult).not.toHaveBeenCalled();
  });

  it("still sends when composing presence fails", async () => {
    sendComposingTo.mockRejectedValueOnce(new Error("presence update unavailable"));

    await expect(
      sendMessageWhatsApp("+1555", "hi", { verbose: false, cfg: WHATSAPP_TEST_CFG }),
    ).resolves.toEqual({ messageId: "msg123", toJid: "1555@s.whatsapp.net" });
    expect(sendComposingTo).toHaveBeenCalledWith("+1555");
    expect(sendMessage).toHaveBeenCalledWith("+1555", "hi", undefined, undefined);
  });

  it("re-chunks after WhatsApp marker expansion", async () => {
    const onDeliveryResult = vi.fn();
    await sendMessageWhatsApp("+1555", Array.from({ length: 8 }, () => "`x`").join(" "), {
      verbose: false,
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
    const assertSendReady = vi.fn(async () => {
      throw new Error("WhatsApp reachout timelock is active");
    });
    hoisted.controllerListeners.set("default", {
      assertSendReady,
      sendComposingTo,
      sendMessage,
      sendPoll,
      sendReaction,
    });

    await expect(
      sendMessageWhatsApp("+1555", "hi", {
        verbose: false,
        cfg: WHATSAPP_TEST_CFG,
      }),
    ).rejects.toThrow("WhatsApp reachout timelock is active");

    expect(assertSendReady).toHaveBeenCalledWith("+1555");
    expect(sendComposingTo).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("returns the actual outbound key remote JID when Baileys resolves a LID target", async () => {
    sendMessage.mockResolvedValueOnce({
      kind: "text",
      messageId: "msg-lid",
      keys: [
        {
          id: "msg-lid",
          remoteJid: "123456789@lid",
          fromMe: true,
        },
      ],
      providerAccepted: true,
    });

    const result = await sendMessageWhatsApp("+1555", "hi", {
      verbose: false,
      cfg: WHATSAPP_TEST_CFG,
    });

    expect(result).toEqual({
      messageId: "msg-lid",
      toJid: "123456789@lid",
    });
  });

  it("preserves intentional indentation when the caller opts out of transport trimming", async () => {
    await sendMessageWhatsApp("+1555", "    indented", {
      verbose: false,
      cfg: WHATSAPP_TEST_CFG,
      preserveLeadingWhitespace: true,
    });

    expect(sendMessage).toHaveBeenLastCalledWith("+1555", "    indented", undefined, undefined);
  });

  it("skips whitespace-only text sends without media", async () => {
    const result = await sendMessageWhatsApp("+1555", "\n \t", {
      verbose: false,
      cfg: WHATSAPP_TEST_CFG,
    });

    expect(result).toEqual({
      messageId: "",
      toJid: "1555@s.whatsapp.net",
    });
    expect(sendComposingTo).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("checks send readiness before standalone direct typing", async () => {
    const assertSendReady = vi.fn(async () => {
      throw new Error("WhatsApp reachout timelock is active");
    });
    hoisted.controllerListeners.set("default", {
      assertSendReady,
      sendComposingTo,
      sendMessage,
      sendPoll,
      sendReaction,
    });

    await expect(
      sendTypingWhatsApp("+1555", {
        cfg: WHATSAPP_TEST_CFG,
      }),
    ).rejects.toThrow("WhatsApp reachout timelock is active");

    expect(assertSendReady).toHaveBeenCalledWith("+1555");
    expect(sendComposingTo).not.toHaveBeenCalled();
  });

  it("throws a helpful error when no active listener exists", async () => {
    hoisted.controllerListeners.clear();
    const error = await sendMessageWhatsApp("+1555", "hi", {
      verbose: false,
      cfg: WHATSAPP_TEST_CFG,
      accountId: "work",
    }).catch((err: unknown) => err);

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

    await expect(
      sendMessageWhatsApp("+1555", "hi", { verbose: false, cfg: WHATSAPP_TEST_CFG }),
    ).rejects.toEqual({ error: { message: "connection closed" } });
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("marks gif playback for video when requested", async () => {
    const buf = Buffer.from("gifvid");
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: buf,
      contentType: "video/mp4",
      kind: "video",
    });
    await sendMessageWhatsApp("+1555", "gif", {
      verbose: false,
      cfg: WHATSAPP_TEST_CFG,
      mediaUrl: "/tmp/anim.mp4",
      gifPlayback: true,
    });
    expect(sendMessage).toHaveBeenLastCalledWith("+1555", "gif", buf, "video/mp4", {
      gifPlayback: true,
    });
  });

  it("infers opaque image uploads from the requested filename", async () => {
    const buffer = Buffer.from("attachment");
    const mediaReadFile = vi.fn(async () => buffer);
    loadWebMediaMock.mockResolvedValueOnce({
      buffer,
      contentType: "application/octet-stream",
      kind: "document",
      fileName: "blob",
    });
    await sendWhatsAppUploadFile("+1555", "attachment", {
      verbose: false,
      cfg: WHATSAPP_TEST_CFG,
      mediaUrl: "https://example.com/blob",
      fileName: "Receipt.png",
      forceDocument: true,
      mediaLocalRoots: ["/tmp/approved"],
      mediaReadFile,
    });
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
    loadWebMediaMock.mockResolvedValueOnce({
      buffer,
      contentType: "application/octet-stream",
      kind: "document",
      fileName: "download.bin",
    });
    await sendWhatsAppUploadFile("+1555", "attachment", {
      verbose: false,
      cfg: WHATSAPP_TEST_CFG,
      mediaUrl: "https://example.com/opaque-document",
      contentType: "application/pdf",
      fileName: "report.pdf",
    });
    expect(sendMessage).toHaveBeenLastCalledWith("+1555", "attachment", buffer, "application/pdf", {
      fileName: "report.pdf",
    });
  });

  it("keeps explicit document delivery for prehydrated video payloads", async () => {
    const buf = Buffer.from("visual-as-document");
    await sendMessageWhatsApp("+1555", "doc", {
      verbose: false,
      cfg: WHATSAPP_TEST_CFG,
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
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: buf,
      contentType: "application/pdf",
      kind: "document",
    });
    await sendMessageWhatsApp("+1555", "doc", {
      verbose: false,
      cfg: WHATSAPP_TEST_CFG,
      mediaUrl: "media://generated",
    });
    expect(sendMessage).toHaveBeenLastCalledWith("+1555", "doc", buf, "application/pdf", {
      fileName: "file.pdf",
    });
  });

  it("forces document branch when forceDocument is true with video media", async () => {
    const buf = Buffer.from("video");
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: buf,
      contentType: "video/mp4",
      kind: "video",
      fileName: "clip.mp4",
    });
    await sendMessageWhatsApp("+1555", "watch", {
      verbose: false,
      cfg: WHATSAPP_TEST_CFG,
      mediaUrl: "/tmp/clip.mp4",
      forceDocument: true,
    });
    expect(sendMessage).toHaveBeenLastCalledWith("+1555", "watch", buf, "video/mp4", {
      asDocument: true,
      fileName: "clip.mp4",
    });
  });

  it("uses account-aware WhatsApp media caps for outbound uploads", async () => {
    hoisted.controllerListeners.set("work", {
      sendComposingTo,
      sendMessage,
      sendPoll,
      sendReaction,
    });
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.from("img"),
      contentType: "image/jpeg",
      kind: "image",
    });

    const cfg = {
      channels: {
        whatsapp: {
          mediaMaxMb: 25,
          accounts: {
            work: {
              mediaMaxMb: 100,
            },
          },
        },
      },
    } as OpenClawConfig;

    await sendMessageWhatsApp("+1555", "pic", {
      verbose: false,
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
      sendPollWhatsApp(
        "+1555",
        { question: "Lunch?", options: ["Pizza", "Sushi"] },
        { verbose: false, cfg: WHATSAPP_TEST_CFG },
      ),
    ).rejects.toBeInstanceOf(PlatformMessageNotDispatchedError);

    expect(sendPoll).toHaveBeenCalledOnce();
  });

  it("checks send readiness before sending direct polls", async () => {
    const assertSendReady = vi.fn(async () => {
      throw new Error("WhatsApp reachout timelock is active");
    });
    hoisted.controllerListeners.set("default", {
      assertSendReady,
      sendComposingTo,
      sendMessage,
      sendPoll,
      sendReaction,
    });

    await expect(
      sendPollWhatsApp(
        "+1555",
        { question: "Lunch?", options: ["Pizza", "Sushi"] },
        { verbose: false, cfg: WHATSAPP_TEST_CFG },
      ),
    ).rejects.toThrow("WhatsApp reachout timelock is active");

    expect(assertSendReady).toHaveBeenCalledWith("+1555");
    expect(sendPoll).not.toHaveBeenCalled();
  });

  it("redacts recipients and poll text in outbound logs", async ({ signal }) => {
    const logPath = path.join(os.tmpdir(), `openclaw-outbound-${crypto.randomUUID()}.log`);
    setLoggerOverride({ level: "trace", file: logPath });

    await sendPollWhatsApp(
      "+1555",
      { question: "Lunch?", options: ["Pizza", "Sushi"], maxSelections: 1 },
      { verbose: false, cfg: WHATSAPP_TEST_CFG },
    );

    const redactedTarget = redactIdentifier("+1555");
    const redactedJid = redactIdentifier("1555@s.whatsapp.net");
    let content = "";
    // The async file transport's flush promise is not exposed through the plugin SDK.
    try {
      for (;;) {
        signal.throwIfAborted();
        content = fsSync.existsSync(logPath) ? fsSync.readFileSync(logPath, "utf-8") : "";
        if ([redactedTarget, redactedJid, "sent poll"].every((text) => content.includes(text))) {
          break;
        }
        await waitForLogTick(10, undefined, { signal });
      }
    } catch (error) {
      if (signal.aborted) {
        throw new Error(`Timed out waiting for the redacted sent-poll log in ${logPath}`, {
          cause: error,
        });
      }
      throw error;
    }
    expect(content).toContain(redactedTarget);
    expect(content).toContain(redactedJid);
    expect(content).toContain("sent poll");

    expect(content).not.toContain(`"to":"+1555"`);
    expect(content).not.toContain(`"jid":"1555@s.whatsapp.net"`);
    expect(content).not.toContain("Lunch?");
  });

  it("sends reactions via active listener", async () => {
    await sendReactionWhatsApp("1555@s.whatsapp.net", "msg123", "✅", {
      verbose: false,
      cfg: WHATSAPP_TEST_CFG,
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
