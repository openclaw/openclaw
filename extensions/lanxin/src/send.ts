import type { ClawdbotConfig } from "openclaw/plugin-sdk/lanxin";
import { lanxinApiPost } from "./client.js";
import { logLanxinDebug } from "./debug.js";
import { normalizeLanxinTarget, parseLanxinTarget, type ParsedLanxinTarget } from "./targets.js";

export type SendLanxinParams = {
  cfg: ClawdbotConfig;
  to: string;
  text: string;
  accountId?: string;
  msgType?: "text" | "image" | "file" | "video";
  mediaType?: number;
  mediaIds?: string[];
};

export type SendLanxinResult = {
  messageId: string;
  chatId: string;
};

type SendLanxinConversationParams = {
  cfg: ClawdbotConfig;
  accountId?: string;
  target: ParsedLanxinTarget;
  text: string;
  msgType?: "text" | "image" | "file" | "video";
  mediaType?: number;
  mediaIds?: string[];
};

export async function sendLanxinByConversation(
  params: SendLanxinConversationParams,
): Promise<SendLanxinResult> {
  const text = params.text.trim();
  const requestedMsgType = params.msgType ?? "text";
  // Compatibility with proven Python client: media is sent via msgType=text
  // and text payload carrying mediaType/mediaIds.
  const msgType = params.mediaIds && params.mediaIds.length > 0 ? "text" : requestedMsgType;
  const mediaIds = (params.mediaIds ?? []).map((id) => id.trim()).filter(Boolean);
  if (!text && mediaIds.length === 0) {
    throw new Error("Lanxin message must be non-empty");
  }

  const payload: { content: string; mediaType?: number; mediaIds?: string[] } = {
    content: text,
  };
  if (mediaIds.length > 0) {
    payload.mediaType = params.mediaType ?? 0;
    payload.mediaIds = mediaIds;
  }
  const msgData = { [msgType]: payload };
  logLanxinDebug(params.cfg, "send conversation", {
    kind: params.target.kind,
    msgType,
    requestedMsgType,
    hasMedia: mediaIds.length > 0,
    mediaCount: mediaIds.length,
    textLength: text.length,
  });
  if (params.target.kind === "direct") {
    await lanxinApiPost({
      cfg: params.cfg,
      accountId: params.accountId,
      path: "bot/messages/create",
      body: {
        userIdList: [params.target.userId],
        entryId: params.target.entryId,
        msgType,
        msgData,
        reminder: {},
      },
    });
    return {
      messageId: `lanxin:direct:${Date.now()}`,
      chatId: `user:${params.target.userId}:${params.target.entryId}`,
    };
  }

  await lanxinApiPost({
    cfg: params.cfg,
    accountId: params.accountId,
    path: "messages/group/create",
    body: {
      groupId: params.target.groupId,
      entryId: params.target.entryId,
      msgType,
      msgData,
      reminder: {},
    },
  });
  return {
    messageId: `lanxin:group:${Date.now()}`,
    chatId: `group:${params.target.groupId}:${params.target.entryId}`,
  };
}

/**
 * Send a text message via Lanxin API.
 * Requires `to` in format `user:<userId>:<entryId>` or `group:<groupId>:<entryId>[:<userId>]`.
 */
export async function sendMessageLanxin(params: SendLanxinParams): Promise<SendLanxinResult> {
  const parsed = parseLanxinTarget(params.to);
  const defaultEntryId =
    typeof params.cfg.channels?.lanxin?.defaultEntryId === "string"
      ? params.cfg.channels.lanxin.defaultEntryId.trim()
      : "";
  const fallbackUserId = normalizeLanxinTarget(params.to);
  const target: ParsedLanxinTarget | null =
    parsed ||
    (fallbackUserId && defaultEntryId
      ? { kind: "direct", userId: fallbackUserId, entryId: defaultEntryId }
      : null);
  if (!target) {
    throw new Error(
      `Invalid Lanxin target "${params.to}". Expected user:<userId>:<entryId> or group:<groupId>:<entryId>, or configure channels.lanxin.defaultEntryId.`,
    );
  }
  logLanxinDebug(params.cfg, "send target resolved", {
    rawTo: params.to,
    target,
  });
  return sendLanxinByConversation({
    cfg: params.cfg,
    accountId: params.accountId,
    target,
    text: params.text,
    msgType: params.msgType,
    mediaType: params.mediaType,
    mediaIds: params.mediaIds,
  });
}
