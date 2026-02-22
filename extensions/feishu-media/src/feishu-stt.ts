/**
 * Feishu native speech_to_text API integration.
 *
 * Extracted from extensions/feishu/src/bot.ts on the dev branch.
 * Provides tenant access token management (with caching) and the
 * Feishu speech recognition endpoint wrapper.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

export type ResolvedAccountInfo = {
  configured: boolean;
  appId?: string;
  appSecret?: string;
  domain?: string;
};

// Token cache (keyed by domain + appId)
const sttTokenCache = new Map<string, { token: string; expiresAt: number }>();

/**
 * Resolve the Feishu/Lark Open-API base URL for the given domain.
 */
export function resolveFeishuApiBase(domain?: string): string {
  if (domain === "lark") {
    return "https://open.larksuite.com/open-apis";
  }
  if (domain && domain !== "feishu" && domain.startsWith("http")) {
    return `${domain.replace(/\/+$/, "")}/open-apis`;
  }
  return "https://open.feishu.cn/open-apis";
}

/**
 * Get (or refresh) a tenant access token for Feishu API calls.
 */
export async function getFeishuTenantAccessToken(params: {
  account: ResolvedAccountInfo;
}): Promise<string> {
  const { account } = params;
  if (!account.appId || !account.appSecret) {
    throw new Error("Feishu appId/appSecret not configured");
  }

  const key = `${account.domain ?? "feishu"}|${account.appId}`;
  const cached = sttTokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.token;
  }

  const res = await fetch(
    `${resolveFeishuApiBase(account.domain)}/auth/v3/tenant_access_token/internal`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: account.appId, app_secret: account.appSecret }),
    },
  );

  const data = (await res.json()) as {
    code: number;
    msg: string;
    tenant_access_token?: string;
    expire?: number;
  };

  if (data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`Token error: ${data.msg}`);
  }

  sttTokenCache.set(key, {
    token: data.tenant_access_token,
    expiresAt: Date.now() + (data.expire ?? 7200) * 1000,
  });

  return data.tenant_access_token;
}

/**
 * Recognize audio using Feishu native speech_to_text API.
 *
 * Silent downgrade: returns undefined on any failure so the original media
 * processing flow is not interrupted.
 */
export async function recognizeAudioWithFeishuStt(params: {
  account: ResolvedAccountInfo;
  audioPath: string;
  messageId: string;
  log?: (msg: string) => void;
}): Promise<string | undefined> {
  const { account, audioPath, messageId, log } = params;
  try {
    log?.(`feishu: STT attempting for ${audioPath}`);
    if (!account.configured) {
      log?.(`feishu: STT skipped - account not configured`);
      return undefined;
    }

    const audioBuf = await readFile(audioPath);
    const token = await getFeishuTenantAccessToken({ account });

    // Small delay to avoid rate-limit when token was just fetched
    await new Promise((r) => setTimeout(r, 500));

    const apiBase = resolveFeishuApiBase(account.domain);
    const fileId = `${messageId}:${randomUUID()}`;

    // Feishu voice messages are typically ogg/opus.
    const reqBody = {
      speech: { speech: audioBuf.toString("base64") },
      config: {
        engine_type: "16k_auto",
        file_id: fileId,
        format: "ogg_opus",
        sample_rate: 16000,
      },
    };

    const doFetch = async () => {
      const r = await fetch(`${apiBase}/speech_to_text/v1/speech/file_recognize`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(reqBody),
      });
      return r;
    };

    let res = await doFetch();
    // Retry once on rate limit (99991400) after waiting for reset
    if (res.status === 429 || res.status === 400) {
      const limit = res.headers.get("x-ogw-ratelimit-limit");
      const resetSec = Number(res.headers.get("x-ogw-ratelimit-reset") || "3");
      const waitMs = Math.max(Math.min(resetSec * 1000, 10000), 3000); // at least 3s
      log?.(`feishu: STT rate-limited, limit=${limit} reset=${resetSec}s, retrying in ${waitMs}ms`);
      await new Promise((r) => setTimeout(r, waitMs));
      res = await doFetch();
    }

    const data = (await res.json()) as {
      code?: number;
      msg?: string;
      data?: { recognition_text?: string };
    };

    log?.(`feishu: STT response code=${data?.code} msg=${data?.msg}`);
    const text = data?.data?.recognition_text?.trim();
    if (!text) {
      log?.(`feishu: STT returned empty text`);
      return undefined;
    }

    log?.(`feishu: STT success (${audioPath}): ${text.slice(0, 80)}`);
    return text;
  } catch (err) {
    // Silent downgrade: do not affect the original media flow.
    log?.(`feishu: STT failed (${audioPath}): ${String(err)}`);
    return undefined;
  }
}
