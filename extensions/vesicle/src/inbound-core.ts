import { isNormalizedSenderAllowed } from "openclaw/plugin-sdk/allow-from";
import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import { resolveDmGroupAccessWithLists } from "openclaw/plugin-sdk/channel-policy";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { extractHandleFromVesicleChatGuid } from "./targets.js";
import type { ResolvedVesicleAccount, VesicleInboundMessage } from "./types.js";

const APPLE_ABSOLUTE_EPOCH_MS = Date.UTC(2001, 0, 1);

type DispatchInboundReplyWithBase =
  typeof import("openclaw/plugin-sdk/inbound-reply-dispatch").dispatchInboundReplyWithBase;

function resolveVesicleTimestamp(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return Date.now();
  }
  if (raw > 1_000_000_000_000_000) {
    return APPLE_ABSOLUTE_EPOCH_MS + Math.floor(raw / 1_000_000);
  }
  if (raw > 1_000_000_000_000) {
    return raw;
  }
  if (raw > 1_000_000_000) {
    return raw * 1000;
  }
  return Date.now();
}

function resolveInboundChatType(message: VesicleInboundMessage): "direct" | "group" {
  if (typeof message.isGroup === "boolean") {
    return message.isGroup ? "group" : "direct";
  }
  return message.chatGuid.includes(";+;") ? "group" : "direct";
}

function resolveDirectPeerId(message: VesicleInboundMessage): string {
  return (
    message.sender.trim() || extractHandleFromVesicleChatGuid(message.chatGuid) || message.chatGuid
  );
}

function resolveVesicleChatIdentifier(chatGuid: string): string | undefined {
  const parts = chatGuid.split(";");
  return parts.length === 3 && parts[2]?.trim() ? parts[2].trim() : undefined;
}

function isDirectSenderAllowed(senderId: string, allowFrom: string[]): boolean {
  return isNormalizedSenderAllowed({
    senderId,
    allowFrom,
  });
}

function isGroupMessageAllowed(message: VesicleInboundMessage, allowFrom: string[]): boolean {
  const candidates = [
    message.sender,
    message.chatGuid,
    resolveVesicleChatIdentifier(message.chatGuid),
  ].filter((entry): entry is string => Boolean(entry?.trim()));
  return candidates.some((senderId) =>
    isNormalizedSenderAllowed({
      senderId,
      allowFrom,
    }),
  );
}

function readReplyText(payload: unknown): string {
  if (!payload || typeof payload !== "object" || !("text" in payload)) {
    return "";
  }
  const text = (payload as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

export async function handleVesicleInboundMessage(params: {
  account: ResolvedVesicleAccount;
  config: OpenClawConfig;
  message: VesicleInboundMessage;
  runtime: PluginRuntime;
  dispatchInboundReplyWithBase: DispatchInboundReplyWithBase;
  sendText: (params: { to: string; text: string }) => Promise<void>;
}): Promise<void> {
  if (params.message.isFromMe === true) {
    return;
  }
  if (!params.message.text.trim()) {
    return;
  }

  const chatType = resolveInboundChatType(params.message);
  const isGroup = chatType === "group";
  const peerId = isGroup ? params.message.chatGuid : resolveDirectPeerId(params.message);
  const access = resolveDmGroupAccessWithLists({
    isGroup,
    dmPolicy: params.account.config.dmPolicy,
    groupPolicy: params.account.config.groupPolicy,
    allowFrom: params.account.config.allowFrom,
    groupAllowFrom: params.account.config.groupAllowFrom,
    groupAllowFromFallbackToAllowFrom: false,
    isSenderAllowed: (allowFrom) =>
      isGroup
        ? isGroupMessageAllowed(params.message, allowFrom)
        : isDirectSenderAllowed(peerId, allowFrom),
  });
  if (access.decision !== "allow") {
    return;
  }
  const target = `chat_guid:${params.message.chatGuid}`;
  const timestamp = resolveVesicleTimestamp(params.message.date);
  const route = params.runtime.channel.routing.resolveAgentRoute({
    cfg: params.config,
    channel: "vesicle",
    accountId: params.account.accountId,
    peer: {
      kind: isGroup ? "group" : "direct",
      id: peerId,
    },
  });
  const wasMentioned = isGroup
    ? params.runtime.channel.mentions.matchesMentionPatterns(
        params.message.text,
        params.runtime.channel.mentions.buildMentionRegexes(params.config, route.agentId),
      )
    : undefined;
  const storePath = params.runtime.channel.session.resolveStorePath(params.config.session?.store, {
    agentId: route.agentId,
  });
  const previousTimestamp = params.runtime.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = params.runtime.channel.reply.formatAgentEnvelope({
    channel: "Vesicle",
    from: params.message.sender || peerId,
    timestamp,
    previousTimestamp,
    envelope: params.runtime.channel.reply.resolveEnvelopeFormatOptions(params.config),
    body: params.message.text,
  });

  const ctxPayload = params.runtime.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: params.message.text,
    RawBody: params.message.text,
    CommandBody: params.message.text,
    From: `vesicle:${params.message.sender || peerId}`,
    To: target,
    SessionKey: route.sessionKey,
    AccountId: route.accountId ?? params.account.accountId,
    ChatType: chatType,
    WasMentioned: wasMentioned,
    ConversationLabel: isGroup ? params.message.chatGuid : params.message.sender || peerId,
    GroupSubject: isGroup ? params.message.chatGuid : undefined,
    GroupChannel: isGroup ? params.message.chatGuid : undefined,
    NativeChannelId: params.message.chatGuid,
    SenderName: params.message.sender,
    SenderId: params.message.sender,
    Provider: "vesicle",
    Surface: "vesicle",
    MessageSid: params.message.messageGuid,
    MessageSidFull: params.message.messageGuid,
    Timestamp: timestamp,
    OriginatingChannel: "vesicle",
    OriginatingTo: target,
    CommandAuthorized: true,
  });

  await params.dispatchInboundReplyWithBase({
    cfg: params.config,
    channel: "vesicle",
    accountId: params.account.accountId,
    route,
    storePath,
    ctxPayload,
    core: params.runtime,
    deliver: async (payload) => {
      const text = readReplyText(payload);
      if (!text.trim()) {
        return;
      }
      await params.sendText({ to: target, text });
    },
    onRecordError: (error) => {
      throw error instanceof Error
        ? error
        : new Error(`Vesicle session record failed: ${String(error)}`);
    },
    onDispatchError: (error) => {
      throw error instanceof Error ? error : new Error(`Vesicle dispatch failed: ${String(error)}`);
    },
  });
}
