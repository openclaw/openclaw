/**
 * WeChat MP 客服消息接口.
 * @see https://developers.weixin.qq.com/doc/offiaccount/Message_Management/Service_Center_messages.html
 */

import { getWeChatMPAccessToken } from "./token.js";
import type { ResolvedWeChatMPAccount } from "./types.js";

export async function sendWeChatMPCustomerMessage(params: {
  account: ResolvedWeChatMPAccount;
  touser: string;
  text: string;
  fetch?: typeof globalThis.fetch;
}): Promise<boolean> {
  const { account, touser, text, fetch: fetcher = globalThis.fetch } = params;
  if (!touser || !text) return false;
  const accessToken = await getWeChatMPAccessToken({
    appId: account.appId,
    appSecret: account.appSecret,
    fetch: fetcher,
  });
  const url = `https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=${encodeURIComponent(accessToken)}`;
  const body = {
    touser,
    msgtype: "text",
    text: { content: text.slice(0, 2048) },
  };
  const res = await fetcher(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) return false;
  const data = (await res.json()) as { errcode?: number };
  return data.errcode === 0;
}
