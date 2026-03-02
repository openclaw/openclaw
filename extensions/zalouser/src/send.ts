import type { ZaloSendOptions, ZaloSendResult } from "./types.js";
import { sendZaloLink, sendZaloTextMessage } from "./zalo-js.js";

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
