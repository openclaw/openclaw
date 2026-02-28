import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk";
import { resolveWeComCredentials } from "./accounts.js";

const accessTokenCache = new Map<string, { token: string; expiresAt: number }>();

const WECOM_API_POLICY = { allowedHostnames: ["qyapi.weixin.qq.com"] };

export async function getWeComAccessToken({
  cfg,
  accountId,
}: {
  cfg: ClawdbotConfig;
  accountId?: string;
}): Promise<string> {
  const { corpId, secret } = resolveWeComCredentials({ cfg, accountId });

  const cached = accessTokenCache.get(corpId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${corpId}&corpsecret=${secret}`;
  const { response, release } = await fetchWithSsrFGuard({
    url,
    policy: WECOM_API_POLICY,
    auditContext: "wecom-get-token",
  });
  let data: { errcode: number; errmsg: string; access_token: string };
  try {
    data = await response.json();
  } finally {
    await release();
  }

  if (data.errcode !== 0) {
    throw new Error(`Failed to get WeCom access token: ${data.errmsg}`);
  }

  // Cache token (expires in 7200 seconds, cache for 7000 to be safe)
  accessTokenCache.set(corpId, {
    token: data.access_token,
    expiresAt: Date.now() + 7000 * 1000,
  });

  return data.access_token;
}

export function clearWeComAccessTokenCache(corpId?: string): void {
  if (corpId) {
    accessTokenCache.delete(corpId);
  } else {
    accessTokenCache.clear();
  }
}
