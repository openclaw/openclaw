import { withDeprecatedWebInboundMessageFlatAliases } from "./message-aliases.js";
import { createAcceptedWhatsAppSendResult } from "./send-result.test-helper.js";
import type {
  LegacyFlatWebInboundMessage,
  WebInboundCallbackMessage,
  WebInboundMessage,
  WhatsAppInboundEvent,
  WhatsAppInboundPayload,
  WhatsAppInboundPlatform,
} from "./types.js";

type TestInboundMessageOverrides = Partial<
  Omit<WebInboundCallbackMessage, "event" | "payload" | "platform">
> & {
  event?: Partial<WhatsAppInboundEvent>;
  payload?: Partial<WhatsAppInboundPayload>;
  platform?: Partial<WhatsAppInboundPlatform>;
};

export function createTestWebInboundMessage(
  overrides: TestInboundMessageOverrides = {},
): WebInboundMessage {
  const { event, payload, platform, ...message } = overrides;
  return withDeprecatedWebInboundMessageFlatAliases({
    event: {
      id: "msg-1",
      ...event,
    },
    payload: {
      body: "hello",
      ...payload,
    },
    platform: {
      chatJid: "+15551234567",
      recipientJid: "+15559876543",
      sendComposing: async () => {},
      reply: async () => createAcceptedWhatsAppSendResult("text", "reply-1"),
      sendMedia: async () => createAcceptedWhatsAppSendResult("media", "media-1"),
      ...platform,
    },
    from: "+15551234567",
    conversationId: "+15551234567",
    accountId: "default",
    chatType: "direct",
    ...message,
  });
}

export function createTestLegacyFlatWebInboundMessage(
  overrides: Partial<LegacyFlatWebInboundMessage> = {},
): LegacyFlatWebInboundMessage {
  return {
    id: "msg-1",
    from: "+15551234567",
    conversationId: "+15551234567",
    accountId: "default",
    chatType: "direct",
    to: "+15559876543",
    body: "hello",
    chatId: "+15551234567",
    sendComposing: async () => {},
    reply: async () => createAcceptedWhatsAppSendResult("text", "reply-1"),
    sendMedia: async () => createAcceptedWhatsAppSendResult("media", "media-1"),
    ...overrides,
  };
}

export function createTestWebAudioInboundMessage(
  overrides: TestInboundMessageOverrides = {},
): WebInboundMessage {
  const { event, payload, platform, ...message } = overrides;
  const media = Object.hasOwn(payload ?? {}, "media")
    ? payload?.media
    : {
        type: "audio/ogg; codecs=opus",
        path: "/tmp/voice.ogg",
      };
  return createTestWebInboundMessage({
    event: {
      id: "msg-1",
      timestamp: 1700000000,
      ...event,
    },
    payload: {
      body: "<media:audio>",
      media,
      ...payload,
    },
    platform: {
      chatJid: "+15550000002",
      recipientJid: "+15550000001",
      ...platform,
    },
    from: "+15550000002",
    conversationId: "+15550000002",
    chatType: "direct",
    accountId: "default",
    accessControlPassed: true,
    ...message,
  });
}
