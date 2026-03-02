import type { ZaloSendOptions, ZaloSendResult } from "./types.js";
import { sendZaloLink, sendZaloTextMessage, sendZaloTypingEvent } from "./zalo-js.js";

export type ZalouserSendOptions = ZaloSendOptions;
export type ZalouserSendResult = ZaloSendResult;

export async function sendMessageZalouser(
  threadId: string,
  text: string,
  options: ZalouserSendOptions = {},
): Promise<ZalouserSendResult> {
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
  await sendZaloTypingEvent(threadId, options);
}
