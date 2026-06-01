import { getTelegramSequentialKey } from "./sequential-key.js";
import {
  buildTelegramReplyFenceLaneKey,
  hasActiveTelegramReplyFenceLane,
} from "./telegram-reply-fence.js";

type TelegramSequentialKeyContext = Parameters<typeof getTelegramSequentialKey>[0];
type TelegramSequentialMessage = NonNullable<TelegramSequentialKeyContext["message"]>;

const TELEGRAM_ACTIVE_RUN_INGRESS_MEDIA_FIELDS = [
  "animation",
  "audio",
  "contact",
  "dice",
  "document",
  "game",
  "location",
  "paid_media",
  "photo",
  "poll",
  "sticker",
  "story",
  "venue",
  "video",
  "video_note",
  "voice",
] as const;

function resolveTelegramSequentialMessage(
  ctx: TelegramSequentialKeyContext,
): TelegramSequentialMessage | undefined {
  return (
    ctx.message ??
    ctx.channelPost ??
    ctx.editedMessage ??
    ctx.editedChannelPost ??
    ctx.update?.message ??
    ctx.update?.edited_message ??
    ctx.update?.channel_post ??
    ctx.update?.edited_channel_post ??
    ctx.update?.callback_query?.message
  );
}

function isTelegramActiveRunIngressText(rawText: unknown): rawText is string {
  if (typeof rawText !== "string") {
    return false;
  }
  const trimmed = rawText.trim();
  return trimmed.length > 0 && !trimmed.startsWith("/");
}

function hasTelegramActiveRunIngressMediaPayload(message: TelegramSequentialMessage): boolean {
  const record = message as unknown as Record<string, unknown>;
  if (record.media_group_id != null) {
    return true;
  }
  return TELEGRAM_ACTIVE_RUN_INGRESS_MEDIA_FIELDS.some((field) => record[field] != null);
}

function isTelegramActiveRunIngressCandidate(ctx: TelegramSequentialKeyContext): boolean {
  const message = resolveTelegramSequentialMessage(ctx);
  if (!message || hasTelegramActiveRunIngressMediaPayload(message)) {
    return false;
  }
  return (
    isTelegramActiveRunIngressText(message.text) || isTelegramActiveRunIngressText(message.caption)
  );
}

function resolveTelegramActiveRunIngressId(
  ctx: TelegramSequentialKeyContext,
  message: TelegramSequentialMessage | undefined,
): string {
  const updateId = (ctx.update as { update_id?: unknown } | undefined)?.update_id;
  if (typeof updateId === "number" && Number.isSafeInteger(updateId)) {
    return `update:${updateId}`;
  }
  const messageId = message?.message_id;
  if (typeof messageId === "number" && Number.isSafeInteger(messageId)) {
    return `message:${messageId}`;
  }
  return `time:${Date.now()}`;
}

export function getTelegramSequentialKeyForAccount(
  ctx: TelegramSequentialKeyContext,
  accountId: string,
): string {
  const sequentialKey = getTelegramSequentialKey(ctx);
  if (!isTelegramActiveRunIngressCandidate(ctx)) {
    return sequentialKey;
  }
  const scopedLaneKey = buildTelegramReplyFenceLaneKey({ accountId, sequentialKey });
  if (!hasActiveTelegramReplyFenceLane(scopedLaneKey)) {
    return sequentialKey;
  }
  const message = resolveTelegramSequentialMessage(ctx);
  return `${sequentialKey}:active-run-ingress:${resolveTelegramActiveRunIngressId(ctx, message)}`;
}
