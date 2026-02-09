/**
 * Outbound send API: POST messages to the Infoflow service.
 * Supports both private (DM) and group chat messages.
 */

import { createHash } from "node:crypto";

const DEFAULT_TIMEOUT_MS = 30_000; // 30 seconds

// Infoflow API endpoints
const INFOFLOW_AUTH_URL = "http://apiin.im.baidu.com/api/v1/auth/app_access_token";
const INFOFLOW_PRIVATE_SEND_URL = "http://apiin.im.baidu.com/api/v1/app/message/send";
const INFOFLOW_GROUP_SEND_URL = "http://apiin.im.baidu.com/api/v1/robot/msg/groupmsgsend";

// Token cache to avoid fetching token for every message
let tokenCache: { token: string; expiresAt: number } | null = null;

// ---------------------------------------------------------------------------
// Token Management
// ---------------------------------------------------------------------------

/**
 * Gets the app access token from Infoflow API.
 * Token is cached and reused until expiry.
 */
export async function getAppAccessToken(params: {
  appKey: string;
  appSecret: string;
  timeoutMs?: number;
}): Promise<{ ok: boolean; token?: string; error?: string }> {
  const { appKey, appSecret, timeoutMs = DEFAULT_TIMEOUT_MS } = params;

  // Check cache first
  if (tokenCache && tokenCache.expiresAt > Date.now()) {
    return { ok: true, token: tokenCache.token };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    // app_secret needs to be MD5 hashed (lowercase)
    const md5Secret = createHash("md5").update(appSecret).digest("hex").toLowerCase();

    const res = await fetch(INFOFLOW_AUTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_key: appKey, app_secret: md5Secret }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }

    const data = (await res.json()) as Record<string, unknown>;

    if (data.errcode && data.errcode !== 0) {
      const errMsg = String(data.errmsg ?? `errcode ${data.errcode}`);
      return { ok: false, error: errMsg };
    }

    const dataField = data.data as { app_access_token?: string; expires_in?: number } | undefined;
    const token = dataField?.app_access_token;
    const expiresIn = dataField?.expires_in ?? 7200; // default 2 hours

    if (!token) {
      return { ok: false, error: "no token in response" };
    }

    // Cache token (with 5 minute buffer before expiry)
    tokenCache = {
      token,
      expiresAt: Date.now() + (expiresIn - 300) * 1000,
    };

    return { ok: true, token };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: errMsg };
  }
}

// ---------------------------------------------------------------------------
// Private Chat (DM) Message Sending
// ---------------------------------------------------------------------------

/**
 * Sends a private (DM) message to a user.
 * @param touser - Recipient's uuapName (email prefix), multiple users separated by |
 * @param content - Message content
 */
export async function sendInfoflowPrivateMessage(params: {
  appKey: string;
  appSecret: string;
  touser: string;
  content: string;
  msgtype?: "text" | "markdown";
  timeoutMs?: number;
}): Promise<{ ok: boolean; error?: string; invaliduser?: string; msgkey?: string }> {
  const {
    appKey,
    appSecret,
    touser,
    content,
    msgtype = "text",
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = params;

  // Get token first
  const tokenResult = await getAppAccessToken({ appKey, appSecret, timeoutMs });
  if (!tokenResult.ok || !tokenResult.token) {
    return { ok: false, error: tokenResult.error ?? "failed to get token" };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    // Build payload based on message type
    const payload: Record<string, unknown> = {
      touser,
      msgtype,
    };
    if (msgtype === "text") {
      payload.text = { content };
    } else if (msgtype === "markdown") {
      payload.markdown = { content };
    }

    // Build headers with authorization
    const headers = {
      Authorization: `Bearer-${tokenResult.token}`,
      "Content-Type": "application/json; charset=utf-8",
      LOGID: String(Date.now() * 1000 + Math.floor(Math.random() * 1000)),
    };

    const res = await fetch(INFOFLOW_PRIVATE_SEND_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const data = (await res.json()) as Record<string, unknown>;

    // Check for error (errcode-based or code-based)
    if (data.errcode && data.errcode !== 0) {
      const errMsg = String(data.errmsg ?? `errcode ${data.errcode}`);
      return { ok: false, error: errMsg, invaliduser: data.invaliduser as string | undefined };
    }

    const innerData = data.data as { msgkey?: number | string } | undefined;
    const msgkey = innerData?.msgkey != null ? String(innerData.msgkey) : undefined;
    return { ok: true, invaliduser: data.invaliduser as string | undefined, msgkey };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: errMsg };
  }
}

// ---------------------------------------------------------------------------
// Group Chat Message Sending
// ---------------------------------------------------------------------------

/**
 * Sends a group chat message.
 * @param groupId - Target group ID (numeric)
 * @param content - Message content
 */
export async function sendInfoflowGroupMessage(params: {
  appKey: string;
  appSecret: string;
  groupId: number;
  content: string;
  timeoutMs?: number;
}): Promise<{ ok: boolean; error?: string; messageid?: string }> {
  const { appKey, appSecret, groupId, content, timeoutMs = DEFAULT_TIMEOUT_MS } = params;

  // Get token first
  const tokenResult = await getAppAccessToken({ appKey, appSecret, timeoutMs });
  if (!tokenResult.ok || !tokenResult.token) {
    return { ok: false, error: tokenResult.error ?? "failed to get token" };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    // Build group message payload (nested structure)
    const payload = {
      message: {
        header: {
          toid: groupId,
          totype: "GROUP",
          msgtype: "TEXT",
          clientmsgid: Date.now(),
          role: "robot",
        },
        body: [{ type: "TEXT", content }],
      },
    };

    // Build headers with authorization
    const headers = {
      Authorization: `Bearer-${tokenResult.token}`,
      "Content-Type": "application/json",
    };

    const res = await fetch(INFOFLOW_GROUP_SEND_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const data = (await res.json()) as Record<string, unknown>;

    // Infoflow group API returns { "code": "ok" } on success
    const code = typeof data.code === "string" ? data.code : "";
    if (code !== "ok") {
      const errMsg = String(data.message ?? data.errmsg ?? data.msg ?? `code=${code || "unknown"}`);
      return { ok: false, error: errMsg };
    }

    // API may return 'messageid' or 'msgid' depending on version
    const innerData = data.data as
      | { messageid?: number | string; msgid?: number | string }
      | undefined;
    const rawMsgId = innerData?.messageid ?? innerData?.msgid;
    const messageid = rawMsgId != null ? String(rawMsgId) : undefined;
    return { ok: true, messageid };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: errMsg };
  }
}

// ---------------------------------------------------------------------------
// Legacy API (for backward compatibility)
// ---------------------------------------------------------------------------

/**
 * @deprecated Use sendInfoflowPrivateMessage or sendInfoflowGroupMessage instead.
 * This function is kept for backward compatibility with existing code.
 */
export async function sendInfoflowMessage(params: {
  sendUrl: string;
  touser: string;
  mes: string;
  timeoutMs?: number;
}): Promise<{ ok: boolean; error?: string }> {
  const { sendUrl, touser, mes, timeoutMs = DEFAULT_TIMEOUT_MS } = params;

  // Legacy implementation (simple POST without auth)
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(sendUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ touser, mes }),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    return { ok: res.ok, error: res.ok ? undefined : `HTTP ${res.status}` };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: errMsg };
  }
}
