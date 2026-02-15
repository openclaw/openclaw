/**
 * 推推 IM 机器人 API 客户端
 * 文档：推推IM机器人开发文档（alarm.im.qihoo.net）
 * 鉴权：URL 参数 appid + secret
 * 发消息：POST /message/custom/send，响应先看 HTTP 200 再看 errcode 是否为 0
 */

import { request } from "undici";

/** 内网默认域名；外网需申请后使用 TUITUI_API_BASE=https://im.live.360.cn:8282/robot */
const DEFAULT_API_BASE = "https://alarm.im.qihoo.net";

function getApiBase(): string {
  const base = process.env.TUITUI_API_BASE?.trim();
  return base || DEFAULT_API_BASE;
}

export type TuituiSendParams = {
  appId: string;
  secret: string;
  /** 接收人域账号或群 id：纯数字且长度>=10 视为群 id，否则视为域账号 */
  to: string;
  content: string;
};

export type TuituiSendResult = {
  ok: boolean;
  messageId?: string;
  error?: string;
};

/** 文档：tousers 域账号列表 / togroups 群 id 列表，至少填其一且不能混发 */
function isGroupId(to: string): boolean {
  const t = to.trim();
  return /^\d+$/.test(t) && t.length >= 10;
}

/**
 * 发送文本消息
 * 规范：先判断 HTTP status 200，再判断响应 json 中 errcode 是否为 0
 */
export async function sendTuituiMessage(params: TuituiSendParams): Promise<TuituiSendResult> {
  const { appId, secret, to, content } = params;
  if (!appId?.trim() || !secret?.trim()) {
    return { ok: false, error: "未配置 appId 或 secret" };
  }
  if (!to?.trim()) {
    return { ok: false, error: "未提供接收对象 (to)" };
  }

  const textContent = content.trim().slice(0, 50000);
  const body = isGroupId(to)
    ? { togroups: [to.trim()], msgtype: "text", text: { content: textContent } }
    : { tousers: [to.trim()], msgtype: "text", text: { content: textContent } };

  const base = getApiBase().replace(/\/$/, "");
  const url = `${base}/message/custom/send?appid=${encodeURIComponent(appId)}&secret=${encodeURIComponent(secret)}`;

  try {
    const { statusCode, body: resBody } = await request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      bodyTimeout: 15000,
      headersTimeout: 10000,
    });

    const raw = await resBody.text();
    let data: { errcode?: number; errmsg?: string; msgids?: Array<{ user?: string; group?: string; msgid?: string }> } = {};
    try {
      data = JSON.parse(raw) as typeof data;
    } catch {
      // ignore
    }

    if (statusCode !== 200) {
      return {
        ok: false,
        error: (data.errmsg != null ? data.errmsg : raw) || `HTTP ${statusCode}`,
      };
    }

    if (data.errcode !== 0) {
      return {
        ok: false,
        error: data.errmsg != null ? data.errmsg : `errcode ${data.errcode}`,
      };
    }

    const first = data.msgids?.[0];
    const messageId = first?.msgid;
    return { ok: true, messageId };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: errMsg };
  }
}

export type TuituiProbeResult = {
  ok: boolean;
  error?: string;
  elapsedMs: number;
};

/** 改收消息回调 url：POST /robot/webhook/modify，限速 1 次/分钟，修改 5 分钟后生效 */
export async function modifyTuituiWebhookUrl(
  appId: string,
  secret: string,
  callbackUrl: string,
  timeoutMs = 10000,
): Promise<{ ok: boolean; error?: string }> {
  if (!appId?.trim() || !secret?.trim()) {
    return { ok: false, error: "未提供 appId 或 secret" };
  }
  const url = callbackUrl?.trim();
  if (!url || (!url.startsWith("http://") && !url.startsWith("https://"))) {
    return { ok: false, error: "callbackUrl 需为 http(s) 完整 URL" };
  }

  const base = getApiBase().replace(/\/$/, "");
  const apiUrl = `${base}/robot/webhook/modify?appid=${encodeURIComponent(appId)}&secret=${encodeURIComponent(secret)}`;

  try {
    const { statusCode, body: resBody } = await request(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
      bodyTimeout: timeoutMs,
      headersTimeout: timeoutMs,
    });

    const raw = await resBody.text();
    let data: { errcode?: number; errmsg?: string } = {};
    try {
      data = JSON.parse(raw) as typeof data;
    } catch {
      // ignore
    }
    if (statusCode !== 200 || data.errcode !== 0) {
      return { ok: false, error: (data.errmsg != null ? data.errmsg : raw) || `HTTP ${statusCode}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 查询自身属性校验 appid+secret；GET /robot/prop/get */
export async function probeTuitui(
  appId: string,
  secret: string,
  timeoutMs = 5000,
): Promise<TuituiProbeResult> {
  const start = Date.now();
  if (!appId?.trim() || !secret?.trim()) {
    return { ok: false, error: "未提供 appId 或 secret", elapsedMs: Date.now() - start };
  }

  const base = getApiBase().replace(/\/$/, "");
  const url = `${base}/robot/prop/get?appid=${encodeURIComponent(appId)}&secret=${encodeURIComponent(secret)}`;

  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    const { statusCode, body: resBody } = await request(url, {
      method: "GET",
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
      signal: controller.signal,
    });
    clearTimeout(t);

    const raw = await resBody.text();
    const elapsedMs = Date.now() - start;
    let data: { errcode?: number; errmsg?: string } = {};
    try {
      data = JSON.parse(raw) as typeof data;
    } catch {
      return { ok: false, error: raw || `HTTP ${statusCode}`, elapsedMs };
    }

    if (statusCode !== 200 || data.errcode !== 0) {
      return { ok: false, error: data.errmsg != null ? data.errmsg : `errcode ${data.errcode}`, elapsedMs };
    }

    return { ok: true, elapsedMs };
  } catch (err) {
    const elapsedMs = Date.now() - start;
    const errMsg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: errMsg, elapsedMs };
  }
}
