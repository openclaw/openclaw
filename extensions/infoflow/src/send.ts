/**
 * Outbound send API: POST messages to the Infoflow service.
 * Supports both private (DM) and group chat messages.
 */

import { createHash } from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { resolveInfoflowAccount } from "./accounts.js";
import { recordSentMessageId } from "./infoflow-req-parse.js";
import { getInfoflowSendLog } from "./logging.js";
import { getInfoflowRuntime } from "./runtime.js";
import type {
  InfoflowGroupMessageBodyItem,
  InfoflowMessageContentItem,
  ResolvedInfoflowAccount,
} from "./types.js";

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
 * Parses link content format: "href" or "[label]href"
 * Returns both href and label (label defaults to href if not specified)
 */
function parseLinkContent(content: string): { href: string; label: string } {
  if (content.startsWith("[")) {
    const closeBracket = content.indexOf("]");
    if (closeBracket > 1) {
      return {
        label: content.slice(1, closeBracket),
        href: content.slice(closeBracket + 1),
      };
    }
  }
  return { href: content, label: content };
}

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

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), timeoutMs);

    // app_secret needs to be MD5 hashed (lowercase)
    const md5Secret = createHash("md5").update(appSecret).digest("hex").toLowerCase();

    const res = await fetch(`${ensureHttps(apiHost)}${INFOFLOW_AUTH_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_key: appKey, app_secret: md5Secret }),
      signal: controller.signal,
    });

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
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Private Chat (DM) Message Sending
// ---------------------------------------------------------------------------

/**
 * Sends a private (DM) message to a user.
 * @param account - Resolved Infoflow account with config
 * @param toUser - Recipient's uuapName (email prefix), multiple users separated by |
 * @param contents - Array of content items (text/markdown; "at" is ignored for private messages)
 */
export async function sendInfoflowPrivateMessage(params: {
  account: ResolvedInfoflowAccount;
  toUser: string;
  contents: InfoflowMessageContentItem[];
  timeoutMs?: number;
}): Promise<{ ok: boolean; error?: string; invaliduser?: string; msgkey?: string }> {
  const { account, toUser, contents, timeoutMs = DEFAULT_TIMEOUT_MS } = params;
  const { apiHost, appKey, appSecret } = account.config;

  // Validate account config
  if (!appKey || !appSecret) {
    return { ok: false, error: "Infoflow appKey/appSecret not configured." };
  }

  // Check if contents contain link type
  const hasLink = contents.some((item) => item.type.toLowerCase() === "link");

  // Get token first
  const tokenResult = await getAppAccessToken({ apiHost, appKey, appSecret, timeoutMs });
  if (!tokenResult.ok || !tokenResult.token) {
    getInfoflowSendLog().error(`[infoflow:sendPrivate] token error: ${tokenResult.error}`);
    return { ok: false, error: tokenResult.error ?? "failed to get token" };
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), timeoutMs);

    let payload: Record<string, unknown>;

    if (hasLink) {
      // Build richtext format payload when link is present
      const richtextContent: Array<{ type: string; text?: string; href?: string; label?: string }> =
        [];

      for (const item of contents) {
        const type = item.type.toLowerCase();
        if (type === "text") {
          richtextContent.push({ type: "text", text: item.content });
        } else if (type === "md" || type === "markdown") {
          richtextContent.push({ type: "text", text: item.content });
        } else if (type === "link") {
          if (item.content) {
            const { href, label } = parseLinkContent(item.content);
            richtextContent.push({ type: "a", href, label });
          }
        }
      }

      if (richtextContent.length === 0) {
        return { ok: false, error: "no valid content for private message" };
      }

      payload = {
        touser: toUser,
        msgtype: "richtext",
        richtext: { content: richtextContent },
      };
    } else {
      // Original logic: filter text/markdown contents and merge with '\n'
      const textParts: string[] = [];
      let hasMarkdown = false;

      for (const item of contents) {
        const type = item.type.toLowerCase();
        if (type === "text") {
          textParts.push(item.content);
        } else if (type === "md" || type === "markdown") {
          textParts.push(item.content);
          hasMarkdown = true;
        }
      }

      if (textParts.length === 0) {
        return { ok: false, error: "no valid content for private message" };
      }

      const mergedContent = textParts.join("\n");
      const msgtype: string = hasMarkdown ? "md" : "text";

      payload = { touser: toUser, msgtype };
      if (msgtype === "text") {
        payload.text = { content: mergedContent };
      } else {
        payload.md = { content: mergedContent };
      }
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

    const data = JSON.parse(await res.text()) as Record<string, unknown>;

    // Check outer code first
    const code = typeof data.code === "string" ? data.code : "";
    if (code !== "ok") {
      const errMsg = String(data.message ?? data.errmsg ?? `code=${code || "unknown"}`);
      getInfoflowSendLog().error(`[infoflow:sendPrivate] failed: ${errMsg}`);
      return { ok: false, error: errMsg };
    }

    // Check inner data.errcode
    const innerData = data.data as Record<string, unknown> | undefined;
    const errcode = innerData?.errcode;
    if (errcode != null && errcode !== 0) {
      const errMsg = String(innerData?.errmsg ?? `errcode ${errcode}`);
      getInfoflowSendLog().error(`[infoflow:sendPrivate] failed: ${errMsg}`);
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

    return { ok: true, invaliduser: innerData?.invaliduser as string | undefined, msgkey };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    getInfoflowSendLog().error(`[infoflow:sendPrivate] exception: ${errMsg}`);
    return { ok: false, error: errMsg };
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Group Chat Message Sending
// ---------------------------------------------------------------------------

/**
 * Sends a group chat message.
 * @param account - Resolved Infoflow account with config
 * @param groupId - Target group ID (numeric)
 * @param contents - Array of content items (text/markdown/at)
 */
export async function sendInfoflowGroupMessage(params: {
  account: ResolvedInfoflowAccount;
  groupId: number;
  contents: InfoflowMessageContentItem[];
  timeoutMs?: number;
}): Promise<{ ok: boolean; error?: string; messageid?: string }> {
  const { account, groupId, contents, timeoutMs = DEFAULT_TIMEOUT_MS } = params;
  const { apiHost, appKey, appSecret } = account.config;

  // Validate account config
  if (!appKey || !appSecret) {
    return { ok: false, error: "Infoflow appKey/appSecret not configured." };
  }

  // Validate contents
  if (contents.length === 0) {
    return { ok: false, error: "contents array is empty" };
  }

  // Build group message body from contents
  let hasMarkdown = false;
  const body: InfoflowGroupMessageBodyItem[] = [];
  for (const item of contents) {
    const type = item.type.toLowerCase();
    if (type === "text") {
      body.push({ type: "TEXT", content: item.content });
    } else if (type === "md" || type === "markdown") {
      body.push({ type: "MD", content: item.content });
      hasMarkdown = true;
    } else if (type === "at") {
      // Parse AT content: "all" means atall, otherwise comma-separated user IDs
      if (item.content === "all") {
        body.push({ type: "AT", atall: true, atuserids: [] });
      } else {
        const userIds = item.content
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (userIds.length > 0) {
          body.push({ type: "AT", atuserids: userIds });
        }
      }
    } else if (type === "link") {
      // Group messages only use href (label is ignored)
      if (item.content) {
        const { href } = parseLinkContent(item.content);
        body.push({ type: "LINK", href });
      }
    }
  }

  const headerMsgType = hasMarkdown ? "MD" : "TEXT";

  // Get token first
  const tokenResult = await getAppAccessToken({ apiHost, appKey, appSecret, timeoutMs });
  if (!tokenResult.ok || !tokenResult.token) {
    getInfoflowSendLog().error(`[infoflow:sendGroup] token error: ${tokenResult.error}`);
    return { ok: false, error: tokenResult.error ?? "failed to get token" };
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), timeoutMs);

    const payload = {
      message: {
        header: {
          toid: groupId,
          totype: "GROUP",
          msgtype: headerMsgType,
          clientmsgid: Date.now(),
          role: "robot",
        },
        body,
      },
    };

    // NOTE: Infoflow API requires "Bearer-<token>" format (with hyphen, not space).
    // This is a non-standard format specific to Infoflow service. Do not modify
    // unless the Infoflow API specification changes.
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

    const data = JSON.parse(await res.text()) as Record<string, unknown>;

    // Check outer code first
    const code = typeof data.code === "string" ? data.code : "";
    if (code !== "ok") {
      const errMsg = String(data.message ?? data.errmsg ?? `code=${code || "unknown"}`);
      getInfoflowSendLog().error(`[infoflow:sendGroup] failed: ${errMsg}`);
      return { ok: false, error: errMsg };
    }

    // Check inner data.errcode
    const innerData = data.data as Record<string, unknown> | undefined;
    const errcode = innerData?.errcode;
    if (errcode != null && errcode !== 0) {
      const errMsg = String(innerData?.errmsg ?? `errcode ${errcode}`);
      getInfoflowSendLog().error(`[infoflow:sendGroup] failed: ${errMsg}`);
      return { ok: false, error: errMsg };
    }

    // Extract message ID from nested data.data structure and record for dedup
    const nestedData = innerData?.data as Record<string, unknown> | undefined;
    const messageid = extractMessageId(nestedData ?? innerData ?? {});
    if (messageid) {
      recordSentMessageId(messageid);
    }

    return { ok: true, messageid };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    getInfoflowSendLog().error(`[infoflow:sendGroup] exception: ${errMsg}`);
    return { ok: false, error: errMsg };
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Unified Message Sending
// ---------------------------------------------------------------------------

/**
 * Unified message sending entry point.
 * Parses the `to` target and dispatches to group or private message sending.
 * @param cfg - OpenClaw config
 * @param to - Target: "username" for private, "group:123" for group
 * @param contents - Array of content items (text/markdown/at)
 * @param accountId - Optional account ID for multi-account support
 */
export async function sendInfoflowMessage(params: {
  cfg: OpenClawConfig;
  to: string;
  contents: InfoflowMessageContentItem[];
  accountId?: string;
}): Promise<{ ok: boolean; error?: string; messageId?: string }> {
  const { cfg, to, contents, accountId } = params;

  // Resolve account config
  const account = resolveInfoflowAccount({ cfg, accountId });
  const { appKey, appSecret } = account.config;

  if (!appKey || !appSecret) {
    return { ok: false, error: "Infoflow appKey/appSecret not configured." };
  }

  // Validate contents
  if (contents.length === 0) {
    return { ok: false, error: "contents array is empty" };
  }

  // Parse target: remove "infoflow:" prefix if present
  const target = to.replace(/^infoflow:/i, "");

  // Check if target is a group (format: group:123)
  const groupMatch = target.match(/^group:(\d+)/i);
  if (groupMatch) {
    const groupId = Number(groupMatch[1]);
    const result = await sendInfoflowGroupMessage({ account, groupId, contents });
    return {
      ok: result.ok,
      error: result.error,
      messageId: result.messageid,
    };
  }

  // Private message (DM)
  const result = await sendInfoflowPrivateMessage({ account, toUser: target, contents });
  return {
    ok: result.ok,
    error: result.error,
    messageId: result.msgkey,
  };
}

// ---------------------------------------------------------------------------
// Test-only exports (@internal — not part of the public API)
// ---------------------------------------------------------------------------

/** @internal — Clears the token cache. Only use in tests. */
export function _resetTokenCache(): void {
  tokenCacheMap.clear();
}
