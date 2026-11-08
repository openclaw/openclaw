import type { WAMessage } from "baileys";
import {
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS } from "openclaw/plugin-sdk/media-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createWebSendApi } from "./inbound/send-api.js";
import { createAcceptedWhatsAppSendResult } from "./inbound/send-result.test-helper.js";
import type { ActiveWebListener } from "./inbound/types.js";
import { sendMessageWhatsApp } from "./send.js";

const hoisted = vi.hoisted(() => ({
  loadOutboundMediaFromUrl: vi.fn(),
  controllerListeners: new Map<string, ActiveWebListener>(),
  transcodeAudioBufferToOpus: vi.fn(),
}));
const recordChannelActivity = vi.hoisted(() => vi.fn());
const loadWebMediaMock = hoisted.loadOutboundMediaFromUrl;
const WHATSAPP_TEST_CFG: OpenClawConfig = { channels: { whatsapp: {} } };

vi.mock("openclaw/plugin-sdk/channel-activity-runtime", async () => {
  const actual = await vi.importActual<
    typeof import("openclaw/plugin-sdk/channel-activity-runtime")
  >("openclaw/plugin-sdk/channel-activity-runtime");
  return { ...actual, recordChannelActivity };
});

// mock-isolation: Route voice deliveries only through this suite's synthetic active listeners.
vi.mock("./connection-controller-runtime-context.js", () => ({
  getWhatsAppConnectionController: vi.fn((accountId: string) => {
    const listener = hoisted.controllerListeners.get(accountId) ?? null;
    return listener ? { getActiveListener: () => listener } : null;
  }),
}));

vi.mock("openclaw/plugin-sdk/outbound-media", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/outbound-media")>(
    "openclaw/plugin-sdk/outbound-media",
  );
  return { ...actual, loadOutboundMediaFromUrl: hoisted.loadOutboundMediaFromUrl };
});

vi.mock("openclaw/plugin-sdk/media-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/media-runtime")>(
    "openclaw/plugin-sdk/media-runtime",
  );
  return { ...actual, transcodeAudioBufferToOpus: hoisted.transcodeAudioBufferToOpus };
});

const sendComposingTo = vi.fn(async () => {});
const sendMessage = vi.fn(async () => createAcceptedWhatsAppSendResult("text", "msg123"));
const sendPoll = vi.fn(async () => createAcceptedWhatsAppSendResult("poll", "poll123"));
const sendReaction = vi.fn(async () => createAcceptedWhatsAppSendResult("reaction", "reaction123"));
const listener = { sendComposingTo, sendMessage, sendPoll, sendReaction };

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.transcodeAudioBufferToOpus.mockReset().mockResolvedValue(Buffer.from("opus-output"));
  loadWebMediaMock.mockReset();
  hoisted.controllerListeners.clear();
  hoisted.controllerListeners.set("default", listener);
});

afterEach(() => {
  recordChannelActivity.mockReset();
  hoisted.controllerListeners.clear();
});

it.each(["ogg", "m4a"])("delivers %s voice and caption in one activity scope", async (format) => {
  recordChannelActivity.mockImplementation(() => {
    if (recordChannelActivity.mock.calls.length > 1) {
      throw new Error("gateway caption producer repeated logical delivery bookkeeping");
    }
  });
  const voice = Buffer.from("gateway-voice");
  const native = format === "ogg";
  const caption = native ? "voice caption" : "voice note";
  const fileName = native ? "gateway-voice.ogg" : "voice.m4a";
  loadWebMediaMock.mockResolvedValueOnce({
    buffer: voice,
    contentType: native ? "audio/ogg" : "audio/mp4; codecs=mp4a.40.2",
    kind: "audio",
    ...(native ? {} : { fileName }),
  });
  const providerSendMessage = vi.fn();
  for (const id of ["gateway-scoped-voice", "gateway-scoped-caption"]) {
    providerSendMessage.mockResolvedValueOnce({
      key: { id, remoteJid: "1555@s.whatsapp.net", fromMe: true },
    } as WAMessage);
  }
  const sendApi = createWebSendApi({
    sock: {
      sendMessage: providerSendMessage,
      sendPresenceUpdate: vi.fn(async () => undefined),
    },
    defaultAccountId: "default",
  });
  const listenerSendMessage = vi.fn<ActiveWebListener["sendMessage"]>(
    async (to, text, mediaBuffer, mediaType, options) =>
      await sendApi.sendMessage(to, text, mediaBuffer, mediaType, options),
  );
  hoisted.controllerListeners.set("default", {
    ...listener,
    sendMessage: listenerSendMessage,
  });
  const onDeliveryResult = vi.fn();

  const result = await sendMessageWhatsApp("+1555", caption, {
    verbose: false,
    cfg: WHATSAPP_TEST_CFG,
    mediaUrl: `/tmp/${fileName}`,
    onDeliveryResult,
  });

  expect(result).toEqual({
    messageId: "gateway-scoped-voice",
    toJid: "1555@s.whatsapp.net",
  });
  expect(providerSendMessage.mock.calls).toEqual([
    [
      "1555@s.whatsapp.net",
      {
        audio: native ? voice : Buffer.from("opus-output"),
        ptt: true,
        mimetype: "audio/ogg; codecs=opus",
      },
    ],
    ["1555@s.whatsapp.net", { text: caption }],
  ]);
  expect(listenerSendMessage).toHaveBeenCalledTimes(2);
  expect(onDeliveryResult).toHaveBeenCalledTimes(2);
  for (const [index, kind] of ["media", "text"].entries()) {
    const messageId = index === 0 ? "gateway-scoped-voice" : "gateway-scoped-caption";
    expect(onDeliveryResult).toHaveBeenNthCalledWith(index + 1, {
      messageId,
      toJid: "1555@s.whatsapp.net",
      receipt: expect.objectContaining({
        platformMessageIds: [messageId],
        parts: [expect.objectContaining({ platformMessageId: messageId, kind })],
      }),
    });
  }
  expect(recordChannelActivity).toHaveBeenCalledExactlyOnceWith({
    channel: "whatsapp",
    accountId: "default",
    direction: "outbound",
  });
  if (!native) {
    expect(hoisted.transcodeAudioBufferToOpus).toHaveBeenCalledWith({
      audioBuffer: voice,
      inputFileName: fileName,
      tempPrefix: "whatsapp-voice-",
      outputFileName: "voice.ogg",
      maxDurationSeconds: MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS,
      sampleRateHz: 48000,
      channels: 1,
      bitrate: "64k",
    });
    expect(listenerSendMessage).toHaveBeenNthCalledWith(
      1,
      "+1555",
      "",
      Buffer.from("opus-output"),
      "audio/ogg; codecs=opus",
    );
    expect(listenerSendMessage).toHaveBeenNthCalledWith(2, "+1555", caption, undefined, undefined);
  }
});

it.each([false, true])(
  "preserves receipts after caption failure (accepted: %s)",
  async (accepted) => {
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.from("audio"),
      contentType: "audio/ogg",
      kind: "audio",
    });
    const bookkeepingError = new Error("accepted gateway caption bookkeeping failed");
    const acceptedCaption = createAcceptedWhatsAppSendResult("text", "gateway-caption-accepted");
    const voiceId = accepted ? "gateway-voice-first" : "gateway-voice-accepted";
    sendMessage.mockResolvedValueOnce(createAcceptedWhatsAppSendResult("media", voiceId));
    if (accepted) {
      sendMessage.mockRejectedValueOnce(
        createChannelPartialDeliveryError(bookkeepingError, {
          messageIds: [acceptedCaption.messageId],
          receipt: acceptedCaption.receipt,
          visibleReplySent: true,
        }),
      );
    } else {
      sendMessage.mockResolvedValueOnce({
        kind: "text",
        messageId: "unknown",
        keys: [],
        providerAccepted: false,
      });
    }
    const onDeliveryResult = vi.fn();
    const failure = await sendMessageWhatsApp("+1555", "voice note", {
      verbose: false,
      cfg: WHATSAPP_TEST_CFG,
      mediaUrl: "/tmp/voice.ogg",
      ...(accepted ? {} : { onDeliveryResult }),
    }).catch((caught: unknown) => caught);
    if (!isChannelPartialDeliveryError(failure)) {
      throw new Error("gateway discarded its accepted voice receipt on caption failure");
    }
    const messageIds = accepted ? [voiceId, "gateway-caption-accepted"] : [voiceId];
    expect(failure.deliveryResult).toMatchObject({
      messageIds,
      receipt: { platformMessageIds: messageIds },
    });
    expect(failure).toHaveProperty(
      "cause",
      accepted ? bookkeepingError : expect.any(PlatformMessageNotDispatchedError),
    );
    expect(sendMessage).toHaveBeenCalledTimes(2);
    if (!accepted) {
      expect(onDeliveryResult).toHaveBeenCalledOnce();
      expect(onDeliveryResult).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: voiceId }),
      );
    }
  },
);
