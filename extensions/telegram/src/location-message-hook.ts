// Telegram live-location edits bypass agent dispatch but still need the normal observation hook.
import type { Message } from "grammy/types";
import { formatLocationText } from "openclaw/plugin-sdk/channel-inbound";
import {
  deriveInboundMessageHookContext,
  fireAndForgetHook,
  toPluginMessageContext,
  toPluginMessageReceivedEvent,
} from "openclaw/plugin-sdk/hook-runtime";
import { getGlobalHookRunner } from "openclaw/plugin-sdk/plugin-runtime";
import { extractTelegramLocation } from "./bot/body-helpers.js";
import {
  buildTelegramGroupFrom,
  buildTelegramInboundOriginTarget,
  resolveTelegramMessageThreadSpec,
} from "./bot/helpers.js";

export function emitTelegramLiveLocationMessageHook(params: {
  accountId: string;
  msg: Message;
  updateId: number;
  updateKind: "message" | "edited_message" | "channel_post" | "edited_channel_post";
  isForum: boolean;
}): void {
  const location = extractTelegramLocation(params.msg);
  if (!location) {
    return;
  }
  const msg = params.msg;
  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
  const threadSpec = resolveTelegramMessageThreadSpec(msg, params.isForum);
  const originatingTo = buildTelegramInboundOriginTarget(msg.chat.id, threadSpec);
  const from = isGroup
    ? buildTelegramGroupFrom(msg.chat.id, threadSpec)
    : `telegram:${msg.chat.id}`;
  const body = formatLocationText(location);
  const messageTimestamp = msg.date ? msg.date * 1000 : undefined;
  const editTimestamp = msg.edit_date ? msg.edit_date * 1000 : undefined;
  const canonical = deriveInboundMessageHookContext({
    From: from,
    To: originatingTo,
    OriginatingChannel: "telegram",
    OriginatingTo: originatingTo,
    Provider: "telegram",
    Surface: "telegram",
    AccountId: params.accountId,
    MessageSid: String(msg.message_id),
    MessageSidFull: String(msg.message_id),
    SenderId: msg.from?.id != null ? String(msg.from.id) : undefined,
    SenderName: [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ") || undefined,
    SenderUsername: msg.from?.username,
    Timestamp:
      params.updateKind.startsWith("edited_") && msg.edit_date ? editTimestamp : messageTimestamp,
    Body: body,
    RawBody: body,
    BodyForAgent: body,
    MessageThreadId: threadSpec.id,
    GroupSubject: isGroup ? msg.chat.title : undefined,
    LocationLat: location.latitude,
    LocationLon: location.longitude,
    LocationAccuracy: location.accuracy,
    LocationName: location.name,
    LocationAddress: location.address,
    LocationSource: location.source,
    LocationIsLive: location.isLive,
    LocationLivePeriodSeconds: msg.location?.live_period,
    LocationCaption: location.caption,
    ProviderUpdateId: String(params.updateId),
    ProviderUpdateKind: params.updateKind,
    ProviderMessageTimestamp: messageTimestamp,
    ProviderEditTimestamp: editTimestamp,
    CommandAuthorized: false,
  });
  const context = toPluginMessageContext(canonical);
  const runner = getGlobalHookRunner();
  if (!runner?.hasHooks("message_received", context)) {
    return;
  }
  fireAndForgetHook(
    runner.runMessageReceived(toPluginMessageReceivedEvent(canonical), context),
    "message_received plugin hook failed",
  );
}
