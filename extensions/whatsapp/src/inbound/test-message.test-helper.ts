import type { WhatsAppInboundAdmission } from "./admission.js";
import { resolveWhatsAppGroupConversationId } from "./group-conversation.js";
import { withDeprecatedWebInboundMessageFlatAliases } from "./message-aliases.js";
import { createAcceptedWhatsAppSendResult } from "./send-result.test-helper.js";
import type {
  LegacyFlatWebInboundMessage,
  AdmittedWebInboundMessage,
  WebInboundCallbackMessage,
  WebInboundMessage,
} from "./types.js";

type WhatsAppInboundEvent = WebInboundCallbackMessage["event"];
type WhatsAppInboundPayload = WebInboundCallbackMessage["payload"];
type WhatsAppInboundPlatform = WebInboundCallbackMessage["platform"];

type TestWhatsAppInboundAdmissionOverrides = Partial<
  Omit<
    WhatsAppInboundAdmission,
    | "account"
    | "conversation"
    | "sender"
    | "ingress"
    | "senderAccess"
    | "commandAccess"
    | "activationAccess"
    | "turnAdmission"
  >
> & {
  account?: Partial<WhatsAppInboundAdmission["account"]>;
  conversation?: Partial<WhatsAppInboundAdmission["conversation"]>;
  sender?: Partial<WhatsAppInboundAdmission["sender"]>;
  ingress?: Partial<WhatsAppInboundAdmission["ingress"]>;
  senderAccess?: Partial<WhatsAppInboundAdmission["senderAccess"]>;
  commandAccess?: Partial<WhatsAppInboundAdmission["commandAccess"]>;
  activationAccess?: Partial<WhatsAppInboundAdmission["activationAccess"]>;
  turnAdmission?: WhatsAppInboundAdmission["turnAdmission"];
};

type TestInboundMessageOverrides = Partial<
  Omit<
    WebInboundCallbackMessage,
    | "event"
    | "payload"
    | "platform"
    | "admission"
    | "from"
    | "conversationId"
    | "accountId"
    | "accessControlPassed"
    | "chatType"
  >
> & {
  admission?: TestWhatsAppInboundAdmissionOverrides;
  event?: Partial<WhatsAppInboundEvent>;
  payload?: Partial<WhatsAppInboundPayload>;
  platform?: Partial<WhatsAppInboundPlatform>;
};

export function createTestWhatsAppInboundAdmission(
  overrides: TestWhatsAppInboundAdmissionOverrides = {},
): WhatsAppInboundAdmission {
  const conversationId = overrides.conversation?.id ?? "+15551234567";
  const accountId = overrides.accountId ?? overrides.account?.accountId ?? "default";
  const kind = overrides.conversation?.kind ?? "direct";

  const ingress: WhatsAppInboundAdmission["ingress"] = {
    admission: "dispatch",
    decision: "allow",
    decisiveGateId: "activation",
    reasonCode: "activation_allowed",
    ...overrides.ingress,
  };
  const turnAdmission: WhatsAppInboundAdmission["turnAdmission"] =
    overrides.turnAdmission ??
    (ingress.admission === "dispatch"
      ? { kind: "dispatch", reason: ingress.reasonCode }
      : ingress.admission === "observe"
        ? { kind: "observeOnly", reason: ingress.reasonCode }
        : {
            kind: "drop",
            reason: ingress.reasonCode,
            ...(ingress.admission === "skip" ? { recordHistory: false } : {}),
          });

  return {
    accountId,
    isSelfChat: overrides.isSelfChat ?? false,
    account: {
      accountId,
      enabled: true,
      sendReadReceipts: true,
      ...overrides.account,
    },
    conversation: {
      kind,
      id: conversationId,
      groupSessionId:
        overrides.conversation?.groupSessionId ??
        resolveWhatsAppGroupConversationId(conversationId),
    },
    sender: {
      id: overrides.sender?.id ?? conversationId,
      isSamePhone: overrides.sender?.isSamePhone ?? false,
    },
    ingress,
    senderAccess: {
      allowed: true,
      decision: "allow",
      reasonCode: "dm_policy_allowlisted",
      providerMissingFallbackApplied: false,
      ...overrides.senderAccess,
    },
    commandAccess: {
      requested: false,
      authorized: false,
      shouldBlockControlCommand: false,
      reasonCode: "command_authorized",
      ...overrides.commandAccess,
    },
    activationAccess: {
      ran: true,
      allowed: true,
      shouldSkip: false,
      reasonCode: "activation_allowed",
      ...overrides.activationAccess,
    },
    turnAdmission,
  };
}

export function createTestWebInboundMessage(
  overrides: TestInboundMessageOverrides = {},
): WebInboundMessage & AdmittedWebInboundMessage {
  const { admission: admissionOverrides, event, payload, platform, ...message } = overrides;
  const admission = createTestWhatsAppInboundAdmission(admissionOverrides);
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
    admission,
    ...message,
  }) as WebInboundMessage & AdmittedWebInboundMessage;
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
): WebInboundMessage & AdmittedWebInboundMessage {
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
    admission: {
      accountId: "default",
      conversation: {
        kind: "direct",
        id: "+15550000002",
      },
      ingress: {
        decision: "allow",
      },
    },
    ...message,
  });
}
