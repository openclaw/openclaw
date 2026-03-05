import { getProtectedDestinationMap, guardWrite } from "openclaw/plugin-sdk/zalouser";
import { getZalouserRuntime } from "./runtime.js";
import type { ZaloEventMessage, ZaloSendOptions, ZaloSendResult } from "./types.js";
import {
  sendZaloDeliveredEvent,
  sendZaloLink,
  sendZaloReaction,
  sendZaloSeenEvent,
  sendZaloTextMessage,
  sendZaloTypingEvent,
} from "./zalo-js.js";

export type ZalouserSendOptions = ZaloSendOptions;
export type ZalouserSendResult = ZaloSendResult;

function resolveProtectedMap() {
  try {
    return getProtectedDestinationMap(getZalouserRuntime().config.loadConfig());
  } catch {
    return getProtectedDestinationMap({});
  }
}

export async function sendMessageZalouser(
  threadId: string,
  text: string,
  options: ZalouserSendOptions = {},
): Promise<ZalouserSendResult> {
  if (
    !guardWrite(
      "pairing",
      { channel: "zalouser", to: threadId, accountId: options.profile },
      resolveProtectedMap(),
    )
  ) {
    return { ok: true, messageId: "suppressed" };
  }
  return await sendZaloTextMessage(threadId, text, options);
}

export async function sendImageZalouser(
  threadId: string,
  imageUrl: string,
  options: ZalouserSendOptions = {},
): Promise<ZalouserSendResult> {
  return await sendZaloTextMessage(threadId, options.caption ?? "", {
    ...options,
    mediaUrl: imageUrl,
  });
}

export async function sendLinkZalouser(
  threadId: string,
  url: string,
  options: ZalouserSendOptions = {},
): Promise<ZalouserSendResult> {
  return await sendZaloLink(threadId, url, options);
}

export async function sendTypingZalouser(
  threadId: string,
  options: Pick<ZalouserSendOptions, "profile" | "isGroup"> = {},
): Promise<void> {
  if (
    !guardWrite(
      "typing",
      { channel: "zalouser", to: threadId, accountId: options.profile },
      resolveProtectedMap(),
    )
  ) {
    return;
  }
  await sendZaloTypingEvent(threadId, options);
}

export async function sendReactionZalouser(params: {
  threadId: string;
  msgId: string;
  cliMsgId: string;
  emoji: string;
  remove?: boolean;
  profile?: string;
  isGroup?: boolean;
}): Promise<ZalouserSendResult> {
  const result = await sendZaloReaction({
    profile: params.profile,
    threadId: params.threadId,
    isGroup: params.isGroup,
    msgId: params.msgId,
    cliMsgId: params.cliMsgId,
    emoji: params.emoji,
    remove: params.remove,
  });
  return {
    ok: result.ok,
    error: result.error,
  };
}

export async function sendDeliveredZalouser(params: {
  threadId: string;
  profile?: string;
  isGroup?: boolean;
  message: ZaloEventMessage;
  isSeen?: boolean;
}): Promise<void> {
  if (
    !guardWrite(
      "read-receipt",
      { channel: "zalouser", to: params.threadId, accountId: params.profile },
      resolveProtectedMap(),
    )
  ) {
    return;
  }
  await sendZaloDeliveredEvent(params);
}

export async function sendSeenZalouser(params: {
  threadId: string;
  profile?: string;
  isGroup?: boolean;
  message: ZaloEventMessage;
}): Promise<void> {
  if (
    !guardWrite(
      "read-receipt",
      { channel: "zalouser", to: params.threadId, accountId: params.profile },
      resolveProtectedMap(),
    )
  ) {
    return;
  }
  await sendZaloSeenEvent(params);
}
