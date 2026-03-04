/**
 * QQ Bot send message (channel).
 * @see https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/send-receive/send.html
 */

import { getQQAccessToken } from "./token.js";
import type { ResolvedQQAccount } from "./types.js";

const QQ_API_BASE = "https://api.sgroup.qq.com";

export async function sendQQMessage(params: {
  account: ResolvedQQAccount;
  channelId: string;
  content: string;
  msgId?: string;
  fetch?: typeof globalThis.fetch;
}): Promise<boolean> {
  const { account, channelId, content, msgId, fetch: fetcher = globalThis.fetch } = params;
  if (!channelId || !content) return false;
  const accessToken = await getQQAccessToken({
    appId: account.appId,
    clientSecret: account.clientSecret,
    fetch: fetcher,
  });
  const url = `${QQ_API_BASE}/channels/${channelId}/messages`;
  const body: Record<string, unknown> = {
    content: content.slice(0, 2000),
  };
  if (msgId) body.msg_id = msgId;
  const res = await fetcher(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `QQBot ${accessToken}`,
    },
    body: JSON.stringify(body),
  });
  return res.ok;
}
