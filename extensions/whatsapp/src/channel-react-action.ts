import {
  isWhatsAppGroupJid,
  resolveReactionMessageId,
  handleWhatsAppAction,
  normalizeWhatsAppTarget,
  readStringOrNumberParam,
  readStringParam,
  type OpenClawConfig,
} from "./channel-react-action.runtime.js";

const WHATSAPP_CHANNEL = "whatsapp" as const;

type WhatsAppMessageActionParams = {
  action: string;
  params: Record<string, unknown>;
  cfg: OpenClawConfig;
  accountId?: string | null;
  requesterSenderId?: string | null;
  toolContext?: {
    currentChannelId?: string | null;
    currentChannelProvider?: string | null;
    currentMessageId?: string | number | null;
  };
};

function isWhatsAppSource(
  toolContext: WhatsAppMessageActionParams["toolContext"] | undefined,
): boolean {
  return toolContext?.currentChannelProvider === WHATSAPP_CHANNEL;
}

function readWhatsAppActionTarget(params: WhatsAppMessageActionParams): string {
  const explicitTarget =
    readStringParam(params.params, "chatJid") ?? readStringParam(params.params, "to");
  if (explicitTarget) {
    return explicitTarget;
  }
  if (isWhatsAppSource(params.toolContext) && params.toolContext?.currentChannelId) {
    return params.toolContext.currentChannelId;
  }
  readStringParam(params.params, "to", { required: true });
  throw new Error("WhatsApp target is required.");
}

async function handleReactAction(params: WhatsAppMessageActionParams) {
  if (params.action !== "react") {
    throw new Error(`Action ${params.action} is not supported for provider ${WHATSAPP_CHANNEL}.`);
  }
  const fromWhatsApp = isWhatsAppSource(params.toolContext);
  const explicitTarget =
    readStringParam(params.params, "chatJid") ?? readStringParam(params.params, "to");
  const normalizedTarget = explicitTarget ? normalizeWhatsAppTarget(explicitTarget) : null;
  const normalizedCurrent =
    fromWhatsApp && params.toolContext?.currentChannelId
      ? normalizeWhatsAppTarget(params.toolContext.currentChannelId)
      : null;
  const isCrossChat =
    normalizedTarget != null &&
    (normalizedCurrent == null || normalizedTarget !== normalizedCurrent);
  const scopedContext =
    !fromWhatsApp || isCrossChat || !params.toolContext
      ? undefined
      : {
          currentChannelId: params.toolContext.currentChannelId ?? undefined,
          currentChannelProvider: params.toolContext.currentChannelProvider ?? undefined,
          currentMessageId: params.toolContext.currentMessageId ?? undefined,
        };
  const messageIdRaw = resolveReactionMessageId({
    args: params.params,
    toolContext: scopedContext,
  });
  if (messageIdRaw == null) {
    readStringParam(params.params, "messageId", { required: true });
  }
  const messageId = String(messageIdRaw);
  const explicitMessageId = readStringOrNumberParam(params.params, "messageId");
  const emoji = readStringParam(params.params, "emoji", { allowEmpty: true });
  const remove = typeof params.params.remove === "boolean" ? params.params.remove : undefined;
  const explicitParticipant = readStringParam(params.params, "participant");
  const inferredParticipant =
    explicitParticipant ||
    explicitMessageId != null ||
    !fromWhatsApp ||
    isCrossChat ||
    !isWhatsAppGroupJid(explicitTarget ?? params.toolContext?.currentChannelId ?? "")
      ? undefined
      : typeof params.requesterSenderId === "string" && params.requesterSenderId.trim().length > 0
        ? params.requesterSenderId.trim()
        : undefined;
  return await handleWhatsAppAction(
    {
      action: "react",
      chatJid:
        readStringParam(params.params, "chatJid") ??
        readStringParam(params.params, "to", { required: true }),
      messageId,
      emoji,
      remove,
      participant: explicitParticipant ?? inferredParticipant,
      accountId: params.accountId ?? undefined,
      fromMe: typeof params.params.fromMe === "boolean" ? params.params.fromMe : undefined,
    },
    params.cfg,
  );
}

export async function handleWhatsAppMessageAction(params: WhatsAppMessageActionParams) {
  if (params.action === "react") {
    return await handleReactAction(params);
  }
  if (params.action === "edit" || params.action === "delete" || params.action === "unsend") {
    const target = readWhatsAppActionTarget(params);
    const messageId = readStringParam(params.params, "messageId", { required: true });
    const message =
      params.action === "edit"
        ? (readStringParam(params.params, "message", { allowEmpty: true }) ??
          readStringParam(params.params, "text", { allowEmpty: true }))
        : undefined;
    return await handleWhatsAppAction(
      {
        action: params.action,
        chatJid: target,
        messageId,
        ...(message !== undefined ? { message } : {}),
        accountId: params.accountId ?? undefined,
      },
      params.cfg,
    );
  }
  throw new Error(`Action ${params.action} is not supported for provider ${WHATSAPP_CHANNEL}.`);
}

/** @deprecated Use handleWhatsAppMessageAction for new WhatsApp message actions. */
export async function handleWhatsAppReactAction(params: WhatsAppMessageActionParams) {
  return await handleWhatsAppMessageAction(params);
}
