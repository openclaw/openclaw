/**
 * Outbound send API: POST messages to the Infoflow service.
 * Supports both private (DM) and group chat messages.
 */

import { createHash } from "node:crypto";
import type { InfoflowAtOptions, InfoflowGroupMessageBodyItem } from "./types.js";
import { recordSentMessageId } from "./infoflow-req-parse.js";
import { getInfoflowRuntime } from "./runtime.js";

const DEFAULT_TIMEOUT_MS = 30_000; // 30 seconds

/**
 * Ensures apiHost uses HTTPS for security (secrets in transit).
 * Allows HTTP only for localhost/127.0.0.1 (local development).
 */
function ensureHttps(apiHost: string): string {
  if (apiHost.startsWith("http://")) {
    const url = new URL(apiHost);
    const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (!isLocal) {
      return apiHost.replace(/^http:/, "https:");
    }
  }
  return apiHost;
}

// Infoflow API paths (host is configured via apiHost in config)
const INFOFLOW_AUTH_PATH = "/api/v1/auth/app_access_token";
const INFOFLOW_PRIVATE_SEND_PATH = "/api/v1/app/message/send";
const INFOFLOW_GROUP_SEND_PATH = "/api/v1/robot/msg/groupmsgsend";

// Token cache to avoid fetching token for every message
// Use Map keyed by appKey to support multi-account isolation
const tokenCacheMap = new Map<string, { token: string; expiresAt: number }>();

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------

/**
 * Extracts message ID from Infoflow API response data.
 * Handles different response formats:
 * - Private: data.msgkey
 * - Group: data.data.messageid or data.data.msgid (nested)
 * - Fallback: data.messageid or data.msgid (flat)
 */
function extractMessageId(data: Record<string, unknown>): string | undefined {
  // Try data.msgkey (private message format)
  if (data.msgkey != null) {
    return String(data.msgkey);
  }

  // Try nested data.data structure (group message format)
  const innerData = data.data as Record<string, unknown> | undefined;
  if (innerData && typeof innerData === "object") {
    // Try data.data.messageid
    if (innerData.messageid != null) {
      return String(innerData.messageid);
    }
    // Try data.data.msgid
    if (innerData.msgid != null) {
      return String(innerData.msgid);
    }
  }

  // Fallback: try flat structure
  if (data.messageid != null) {
    return String(data.messageid);
  }
  if (data.msgid != null) {
    return String(data.msgid);
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Token Management
// ---------------------------------------------------------------------------

/**
 * Gets the app access token from Infoflow API.
 * Token is cached and reused until expiry.
 */
export async function getAppAccessToken(params: {
  apiHost: string;
  appKey: string;
  appSecret: string;
  timeoutMs?: number;
}): Promise<{ ok: boolean; token?: string; error?: string }> {
  const { apiHost, appKey, appSecret, timeoutMs = DEFAULT_TIMEOUT_MS } = params;

  // Check cache first (by appKey for multi-account isolation)
  const cached = tokenCacheMap.get(appKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { ok: true, token: cached.token };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    // app_secret needs to be MD5 hashed (lowercase)
    const md5Secret = createHash("md5").update(appSecret).digest("hex").toLowerCase();

    const res = await fetch(`${ensureHttps(apiHost)}${INFOFLOW_AUTH_PATH}`, {
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

    // Cache token by appKey (with 5 minute buffer before expiry)
    tokenCacheMap.set(appKey, {
      token,
      expiresAt: Date.now() + (expiresIn - 300) * 1000,
    });

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
  apiHost: string;
  appKey: string;
  appSecret: string;
  touser: string;
  content: string;
  msgtype?: "text" | "markdown";
  timeoutMs?: number;
}): Promise<{ ok: boolean; error?: string; invaliduser?: string; msgkey?: string }> {
  const {
    apiHost,
    appKey,
    appSecret,
    touser,
    content,
    msgtype = "text",
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = params;

  // Get verbose state once at start
  let verbose = false;
  try {
    verbose = getInfoflowRuntime().logging.shouldLogVerbose();
  } catch {
    // runtime not available, keep verbose = false
  }

  if (verbose) {
    console.log(`[infoflow:sendPrivate] touser=${touser}, msgtype=${msgtype}`);
  }

  // Get token first
  const tokenResult = await getAppAccessToken({ apiHost, appKey, appSecret, timeoutMs });
  if (!tokenResult.ok || !tokenResult.token) {
    console.error(`[infoflow:sendPrivate] token error: ${tokenResult.error}`);
    return { ok: false, error: tokenResult.error ?? "failed to get token" };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    // Build payload based on message type
    const apiMsgtype = msgtype === "markdown" ? "md" : "text";
    const payload: Record<string, unknown> = { touser, msgtype: apiMsgtype };
    if (apiMsgtype === "text") {
      payload.text = { content };
    } else if (apiMsgtype === "md") {
      payload.md = { content };
    }

    const headers = {
      Authorization: `Bearer-${tokenResult.token}`,
      "Content-Type": "application/json; charset=utf-8",
      LOGID: String(Date.now() * 1000 + Math.floor(Math.random() * 1000)),
    };

    const res = await fetch(`${ensureHttps(apiHost)}${INFOFLOW_PRIVATE_SEND_PATH}`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const data = JSON.parse(await res.text()) as Record<string, unknown>;

    // Check outer code first
    const code = typeof data.code === "string" ? data.code : "";
    if (code !== "ok") {
      const errMsg = String(data.message ?? data.errmsg ?? `code=${code || "unknown"}`);
      console.error(`[infoflow:sendPrivate] failed: ${errMsg}`);
      return { ok: false, error: errMsg };
    }

    // Check inner data.errcode
    const innerData = data.data as Record<string, unknown> | undefined;
    const errcode = innerData?.errcode;
    if (errcode != null && errcode !== 0) {
      const errMsg = String(innerData?.errmsg ?? `errcode ${errcode}`);
      console.error(`[infoflow:sendPrivate] failed: ${errMsg}`);
      return {
        ok: false,
        error: errMsg,
        invaliduser: innerData?.invaliduser as string | undefined,
      };
    }

    // Extract message ID and record for dedup
    const msgkey = extractMessageId(innerData ?? {});
    if (msgkey) {
      recordSentMessageId(msgkey);
    }

    if (verbose) {
      console.log(`[infoflow:sendPrivate] ok, msgkey=${msgkey}`);
    }
    return { ok: true, invaliduser: innerData?.invaliduser as string | undefined, msgkey };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[infoflow:sendPrivate] <<< EXCEPTION: ${errMsg}`);
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
 * @param msgtype - Message type: "text" or "markdown"
 */
export async function sendInfoflowGroupMessage(params: {
  apiHost: string;
  appKey: string;
  appSecret: string;
  groupId: number;
  content: string;
  msgtype?: "text" | "markdown";
  atOptions?: InfoflowAtOptions;
  timeoutMs?: number;
}): Promise<{ ok: boolean; error?: string; messageid?: string }> {
  const {
    apiHost,
    appKey,
    appSecret,
    groupId,
    content,
    msgtype = "text",
    atOptions,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = params;

  // Get verbose state once at start
  let verbose = false;
  try {
    verbose = getInfoflowRuntime().logging.shouldLogVerbose();
  } catch {
    // runtime not available, keep verbose = false
  }

  if (verbose) {
    console.log(`[infoflow:sendGroup] groupId=${groupId}, msgtype=${msgtype}`);
  }

  // Get token first
  const tokenResult = await getAppAccessToken({ apiHost, appKey, appSecret, timeoutMs });
  if (!tokenResult.ok || !tokenResult.token) {
    console.error(`[infoflow:sendGroup] token error: ${tokenResult.error}`);
    return { ok: false, error: tokenResult.error ?? "failed to get token" };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    // Build group message body
    const bodyType = msgtype === "markdown" ? "MD" : "TEXT";
    const body: InfoflowGroupMessageBodyItem[] = [{ type: bodyType, content }];

    // Add AT element if atOptions is provided
    if (atOptions?.atAll || (atOptions?.atUserIds && atOptions.atUserIds.length > 0)) {
      body.push({
        type: "AT",
        atuserids: atOptions.atUserIds ?? [],
        ...(atOptions.atAll && { atall: true }),
      });
    }

    const payload = {
      message: {
        header: {
          toid: groupId,
          totype: "GROUP",
          msgtype: bodyType,
          clientmsgid: Date.now(),
          role: "robot",
        },
        body,
      },
    };

    const headers = {
      Authorization: `Bearer-${tokenResult.token}`,
      "Content-Type": "application/json",
    };

    const res = await fetch(`${ensureHttps(apiHost)}${INFOFLOW_GROUP_SEND_PATH}`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const data = JSON.parse(await res.text()) as Record<string, unknown>;

    // Check outer code first
    const code = typeof data.code === "string" ? data.code : "";
    if (code !== "ok") {
      const errMsg = String(data.message ?? data.errmsg ?? `code=${code || "unknown"}`);
      console.error(`[infoflow:sendGroup] failed: ${errMsg}`);
      return { ok: false, error: errMsg };
    }

    // Check inner data.errcode
    const innerData = data.data as Record<string, unknown> | undefined;
    const errcode = innerData?.errcode;
    if (errcode != null && errcode !== 0) {
      const errMsg = String(innerData?.errmsg ?? `errcode ${errcode}`);
      console.error(`[infoflow:sendGroup] failed: ${errMsg}`);
      return { ok: false, error: errMsg };
    }

    // Extract message ID from nested data.data structure and record for dedup
    const nestedData = innerData?.data as Record<string, unknown> | undefined;
    const messageid = extractMessageId(nestedData ?? innerData ?? {});
    if (messageid) {
      recordSentMessageId(messageid);
    }

    if (verbose) {
      console.log(`[infoflow:sendGroup] ok, messageid=${messageid}`);
    }
    return { ok: true, messageid };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[infoflow:sendGroup] exception: ${errMsg}`);
    return { ok: false, error: errMsg };
  }
}

// ---------------------------------------------------------------------------
// Test-only exports (@internal — not part of the public API)
// ---------------------------------------------------------------------------

/** @internal — Clears the token cache. Only use in tests. */
export function _resetTokenCache(): void {
  tokenCacheMap.clear();
}
