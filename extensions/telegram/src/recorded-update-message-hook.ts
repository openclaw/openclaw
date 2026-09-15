// Telegram updates that the drain records without dispatching an agent turn -- message edits and
// live-location edits -- still need the normal inbound observation hook.
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

/** Text a recorded edit contributes to the observation hook when it carries no location. */
function resolveTelegramEditedMessageText(msg: Message): string | undefined {
  const body = msg.text ?? msg.caption;
  const trimmed = body?.trim();
  return trimmed ? body : undefined;
}

function buildTelegramRecordedUpdateMessageHook(params: {
  accountId: string;
  msg: Message;
  updateId: number;
  updateKind: "message" | "edited_message" | "channel_post" | "edited_channel_post";
  isForum: boolean;
}) {
  const location = extractTelegramLocation(params.msg);
  const isEdit = params.updateKind.startsWith("edited_");
  // Edits without a location still carry the authoritative message body, and the drain records
  // them without an agent turn, so this is the only surface a plugin can observe them on.
  const editedText = location || !isEdit ? undefined : resolveTelegramEditedMessageText(params.msg);
  const body = location ? formatLocationText(location) : editedText;
  if (!body) {
    return null;
  }
  const msg = params.msg;
  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
  const threadSpec = resolveTelegramMessageThreadSpec(msg, params.isForum);
  const originatingTo = buildTelegramInboundOriginTarget(msg.chat.id, threadSpec);
  const from = isGroup
    ? buildTelegramGroupFrom(msg.chat.id, threadSpec)
    : `telegram:${msg.chat.id}`;
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
      params.updateKind.startsWith("edited_") && msg.edit_date
        ? msg.edit_date * 1000
        : msg.date
          ? msg.date * 1000
          : undefined,
    Body: body,
    RawBody: body,
    BodyForAgent: body,
    MessageThreadId: threadSpec.id,
    GroupSubject: isGroup ? msg.chat.title : undefined,
    LocationLat: location?.latitude,
    LocationLon: location?.longitude,
    LocationAccuracy: location?.accuracy,
    LocationName: location?.name,
    LocationAddress: location?.address,
    LocationSource: location?.source,
    LocationIsLive: location?.isLive,
    LocationLivePeriodSeconds: location ? msg.location?.live_period : undefined,
    LocationCaption: location?.caption,
    ProviderUpdateId: String(params.updateId),
    ProviderUpdateKind: params.updateKind,
    ProviderMessageTimestamp: msg.date ? msg.date * 1000 : undefined,
    ProviderEditTimestamp: msg.edit_date ? msg.edit_date * 1000 : undefined,
    CommandAuthorized: false,
  });
  return {
    event: toPluginMessageReceivedEvent(canonical),
    context: toPluginMessageContext(canonical),
  };
}

export function emitTelegramRecordedUpdateMessageHook(
  params: Parameters<typeof buildTelegramRecordedUpdateMessageHook>[0],
): void {
  const pair = buildTelegramRecordedUpdateMessageHook(params);
  const runner = getGlobalHookRunner();
  if (!pair || !runner?.hasHooks("message_received", pair.context)) {
    return;
  }
  fireAndForgetHook(
    runner.runMessageReceived(pair.event, pair.context),
    "message_received plugin hook failed",
  );
}
