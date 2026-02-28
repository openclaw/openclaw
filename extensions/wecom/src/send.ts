import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk";
import { resolveWeComCredentials } from "./accounts.js";
import { getWeComAccessToken } from "./client.js";

const WECOM_API_POLICY = { allowedHostnames: ["qyapi.weixin.qq.com"] };

export async function sendMessageWeCom({
  cfg,
  to,
  text,
  accountId,
}: {
  cfg: ClawdbotConfig;
  to: string;
  text: string;
  accountId?: string;
}): Promise<{ messageId: string }> {
  const accessToken = await getWeComAccessToken({ cfg, accountId });
  const { agentId } = resolveWeComCredentials({ cfg, accountId });

  const url = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${accessToken}`;
  const { response, release } = await fetchWithSsrFGuard({
    url,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        touser: to,
        msgtype: "text",
        agentid: agentId,
        text: { content: text },
      }),
    },
    policy: WECOM_API_POLICY,
    auditContext: "wecom-send-message",
  });
  let data: { errcode: number; errmsg: string; msgid?: string };
  try {
    data = await response.json();
  } finally {
    await release();
  }

  if (data.errcode !== 0) {
    throw new Error(`WeCom send error ${data.errcode}: ${data.errmsg}`);
  }

  return { messageId: data.msgid ?? "" };
}

/**
 * Send message to group chat
 */
export async function sendGroupMessageWeCom({
  cfg,
  chatId,
  text,
  accountId,
}: {
  cfg: ClawdbotConfig;
  chatId: string;
  text: string;
  accountId?: string;
}): Promise<{ messageId: string }> {
  const accessToken = await getWeComAccessToken({ cfg, accountId });

  const url = `https://qyapi.weixin.qq.com/cgi-bin/appchat/send?access_token=${accessToken}`;
  const { response, release } = await fetchWithSsrFGuard({
    url,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatid: chatId, msgtype: "text", text: { content: text } }),
    },
    policy: WECOM_API_POLICY,
    auditContext: "wecom-send-group-message",
  });
  let data: { errcode: number; errmsg: string; msgid?: string };
  try {
    data = await response.json();
  } finally {
    await release();
  }

  if (data.errcode !== 0) {
    throw new Error(`WeCom group send error ${data.errcode}: ${data.errmsg}`);
  }

  return { messageId: data.msgid ?? "" };
}
