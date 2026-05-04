import { jsonResult } from "openclaw/plugin-sdk/channel-actions";
import {
  resolveReactionMessageId,
  handleWhatsAppAction,
  isWhatsAppGroupJid,
  normalizeWhatsAppTarget,
  readStringOrNumberParam,
  readStringParam,
  type OpenClawConfig,
} from "./channel-react-action.runtime.js";
import { lookupInboundMessageMeta } from "./quoted-message.js";

const WHATSAPP_CHANNEL = "whatsapp" as const;
const CURRENT_GROUP_REACTION_COOLDOWN_MS = 180000;
const currentGroupReactionLastSentAt = new Map<string, number>();

function normalizeOptionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeOptionalStringOrNumber(value: string | number | null | undefined) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return normalizeOptionalText(value);
}

export function clearWhatsAppReactActionRateLimitForTests() {
  currentGroupReactionLastSentAt.clear();
}

function markCurrentGroupReactionAllowed(params: {
  accountId?: string | null;
  chatJid: string;
  participant?: string;
  now: number;
}) {
  const key = [
    params.accountId ?? "default",
    normalizeWhatsAppTarget(params.chatJid) ?? params.chatJid,
    params.participant ?? "unknown",
  ].join(":");
  const lastSentAt = currentGroupReactionLastSentAt.get(key);
  if (lastSentAt != null && params.now - lastSentAt < CURRENT_GROUP_REACTION_COOLDOWN_MS) {
    return false;
  }
  currentGroupReactionLastSentAt.set(key, params.now);
  for (const [entryKey, sentAt] of currentGroupReactionLastSentAt) {
    if (params.now - sentAt > CURRENT_GROUP_REACTION_COOLDOWN_MS * 4) {
      currentGroupReactionLastSentAt.delete(entryKey);
    }
  }
  return true;
}

export async function handleWhatsAppReactAction(params: {
  action: string;
  params: Record<string, unknown>;
  cfg: OpenClawConfig;
  accountId?: string | null;
  requesterSenderId?: string | null;
  toolContext?: {
    currentChannelId?: string | null;
    currentChannelProvider?: string | null;
    currentMessageId?: string | number | null;
    currentMessageParticipant?: string | null;
  };
}) {
  if (params.action !== "react") {
    throw new Error(`Action ${params.action} is not supported for provider ${WHATSAPP_CHANNEL}.`);
  }
  const isWhatsAppSource = params.toolContext?.currentChannelProvider === WHATSAPP_CHANNEL;
  const explicitTarget =
    readStringParam(params.params, "chatJid") ?? readStringParam(params.params, "to");
  const normalizedTarget = explicitTarget ? normalizeWhatsAppTarget(explicitTarget) : null;
  const normalizedCurrent =
    isWhatsAppSource && params.toolContext?.currentChannelId
      ? normalizeWhatsAppTarget(params.toolContext.currentChannelId)
      : null;
  const isCrossChat =
    normalizedTarget != null &&
    (normalizedCurrent == null || normalizedTarget !== normalizedCurrent);
  const scopedContext =
    !isWhatsAppSource || isCrossChat || !params.toolContext
      ? undefined
      : {
          currentChannelId: params.toolContext.currentChannelId ?? undefined,
          currentChannelProvider: params.toolContext.currentChannelProvider ?? undefined,
          currentMessageId: params.toolContext.currentMessageId ?? undefined,
          currentMessageParticipant: params.toolContext.currentMessageParticipant ?? undefined,
        };
  const messageIdRaw = resolveReactionMessageId({
    args: params.params,
    toolContext: scopedContext,
  });
  if (messageIdRaw == null) {
    readStringParam(params.params, "messageId", { required: true });
  }
  const explicitMessageId = readStringOrNumberParam(params.params, "messageId");
  const emoji = readStringParam(params.params, "emoji", { allowEmpty: true }) ?? "";
  const remove = typeof params.params.remove === "boolean" ? params.params.remove : undefined;
  const chatJid =
    readStringParam(params.params, "chatJid") ??
    readStringParam(params.params, "to", { required: true });
  const explicitParticipant = readStringParam(params.params, "participant");
  const currentMessageId = normalizeOptionalStringOrNumber(scopedContext?.currentMessageId);
  const currentMessageParticipant = normalizeOptionalText(scopedContext?.currentMessageParticipant);
  const explicitMessageIdText = normalizeOptionalStringOrNumber(explicitMessageId);
  const cacheChatJid = normalizedTarget ?? chatJid;
  const sameCurrentGroup =
    isWhatsAppSource &&
    !isCrossChat &&
    isWhatsAppGroupJid(explicitTarget ?? params.toolContext?.currentChannelId ?? "");
  let messageId = String(messageIdRaw);
  if (
    sameCurrentGroup &&
    currentMessageId &&
    currentMessageParticipant &&
    explicitMessageIdText &&
    explicitMessageIdText !== currentMessageId &&
    explicitParticipant &&
    params.accountId &&
    !lookupInboundMessageMeta(params.accountId, cacheChatJid, explicitMessageIdText)
  ) {
    messageId = currentMessageId;
  }
  const useTrustedCurrentParticipant =
    sameCurrentGroup &&
    currentMessageId &&
    messageId === currentMessageId &&
    currentMessageParticipant;
  let participant: string | undefined;
  if (useTrustedCurrentParticipant) {
    participant = currentMessageParticipant;
  } else if (explicitParticipant) {
    participant = explicitParticipant;
  } else if (
    explicitMessageId == null &&
    isWhatsAppSource &&
    !isCrossChat &&
    isWhatsAppGroupJid(explicitTarget ?? params.toolContext?.currentChannelId ?? "") &&
    typeof params.requesterSenderId === "string" &&
    params.requesterSenderId.trim().length > 0
  ) {
    participant = params.requesterSenderId.trim();
  }
  if (
    sameCurrentGroup &&
    currentMessageId &&
    messageId === currentMessageId &&
    emoji.trim().length > 0 &&
    remove !== true &&
    !markCurrentGroupReactionAllowed({
      accountId: params.accountId,
      chatJid,
      participant,
      now: Date.now(),
    })
  ) {
    return jsonResult({ ok: true, skipped: true, reason: "reaction_cooldown" });
  }
  return await handleWhatsAppAction(
    {
      action: "react",
      chatJid,
      messageId,
      emoji,
      remove,
      participant,
      accountId: params.accountId ?? undefined,
      fromMe: typeof params.params.fromMe === "boolean" ? params.params.fromMe : undefined,
    },
    params.cfg,
  );
}
