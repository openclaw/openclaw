import {
  handleWhatsAppAction,
  normalizeWhatsAppTarget,
  readStringParam,
} from "./channel-message-action.runtime.js";
import { handleWhatsAppReactAction } from "./channel-react-action.js";

const WHATSAPP_CHANNEL = "whatsapp" as const;

type WhatsAppMessageActionParams = {
  action: string;
  params: Record<string, unknown>;
  cfg: Parameters<typeof handleWhatsAppAction>[1];
  accountId?: string | null;
  requesterSenderId?: string | null;
  mediaAccess?: {
    localRoots?: readonly string[];
    readFile?: (filePath: string) => Promise<Buffer>;
  };
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  toolContext?: {
    currentChannelId?: string | null;
    currentChannelProvider?: string | null;
    currentMessageId?: string | number | null;
  };
};

export async function handleWhatsAppMessageAction(params: WhatsAppMessageActionParams) {
  if (params.action === "upload-file" || params.action === "react") {
    return await handleWhatsAppReactAction(params);
  }
  if (params.action !== "list-reply") {
    throw new Error(`Action ${params.action} is not supported for provider ${WHATSAPP_CHANNEL}.`);
  }

  const isWhatsAppSource = params.toolContext?.currentChannelProvider === WHATSAPP_CHANNEL;
  const explicitTarget =
    readStringParam(params.params, "chatJid") ??
    readStringParam(params.params, "chatId") ??
    readStringParam(params.params, "to");
  const normalizedTarget = explicitTarget ? normalizeWhatsAppTarget(explicitTarget) : null;
  const normalizedCurrent =
    isWhatsAppSource && params.toolContext?.currentChannelId
      ? normalizeWhatsAppTarget(params.toolContext.currentChannelId)
      : null;
  const isCurrentChat =
    normalizedTarget != null && normalizedCurrent != null && normalizedTarget === normalizedCurrent;
  const messageId =
    readStringParam(params.params, "messageId") ??
    readStringParam(params.params, "replyToId") ??
    (isCurrentChat && params.toolContext?.currentMessageId != null
      ? String(params.toolContext.currentMessageId)
      : undefined);

  return await handleWhatsAppAction(
    {
      ...params.params,
      action: "list-reply",
      accountId: params.accountId ?? undefined,
      ...(messageId ? { messageId } : {}),
    },
    params.cfg,
  );
}
