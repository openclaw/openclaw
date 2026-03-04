/**
 * Inbound webhook handler for Synology Chat outgoing webhooks.
 * Parses form-urlencoded/JSON body, validates security, delivers to agent.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import * as querystring from "node:querystring";
import {
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
} from "openclaw/plugin-sdk/compat";
import { sendMessage, resolveChatUserId } from "./client.js";
import { validateToken, authorizeUserForDm, sanitizeInput, RateLimiter } from "./security.js";
import type { SynologyWebhookPayload, ResolvedSynologyChatAccount } from "./types.js";

// One rate limiter per account, created lazily
const rateLimiters = new Map<string, RateLimiter>();

function getRateLimiter(account: ResolvedSynologyChatAccount): RateLimiter {
  let rl = rateLimiters.get(account.accountId);
  if (!rl || rl.maxRequests() !== account.rateLimitPerMinute) {
    rl?.clear();
    rl = new RateLimiter(account.rateLimitPerMinute);
    rateLimiters.set(account.accountId, rl);
  }
  return rl;
}

export function clearSynologyWebhookRateLimiterStateForTest(): void {
  for (const limiter of rateLimiters.values()) {
    limiter.clear();
  }
  rateLimiters.clear();
}

export function getSynologyWebhookRateLimiterCountForTest(): number {
  return rateLimiters.size;
}

/** Read the full request body as a string. */
async function readBody(req: IncomingMessage): Promise<
  | { ok: true; body: string }
  | {
      ok: false;
      statusCode: number;
      error: string;
    }
> {
  try {
    const body = await readRequestBodyWithLimit(req, {
      maxBytes: 1_048_576,
      timeoutMs: 30_000,
    });
    return { ok: true, body };
  } catch (err) {
    if (isRequestBodyLimitError(err)) {
      return {
        ok: false,
        statusCode: err.statusCode,
        error: requestBodyErrorToText(err.code),
      };
    }
    return {
      ok: false,
      statusCode: 400,
      error: "Invalid request body",
    };
  }
}

function firstNonEmptyString(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const normalized = firstNonEmptyString(item);
      if (normalized) return normalized;
    }
    return undefined;
  }
  if (value === null || value === undefined) return undefined;
  const str = String(value).trim();
  return str.length > 0 ? str : undefined;
}

function pickAlias(record: Record<string, unknown>, aliases: string[]): string | undefined {
  for (const alias of aliases) {
    const normalized = firstNonEmptyString(record[alias]);
    if (normalized) return normalized;
  }
  return undefined;
}

function parseQueryParams(req: IncomingMessage): Record<string, unknown> {
  try {
    const url = new URL(req.url ?? "", "http://localhost");
    const out: Record<string, unknown> = {};
    for (const [key, value] of url.searchParams.entries()) {
      out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function parseFormBody(body: string): Record<string, unknown> {
  return querystring.parse(body) as Record<string, unknown>;
}

function parseJsonBody(body: string): Record<string, unknown> {
  if (!body.trim()) return {};
  const parsed = JSON.parse(body);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("Invalid JSON body");
  }
  return parsed as Record<string, unknown>;
}

function headerValue(header: string | string[] | undefined): string | undefined {
  return firstNonEmptyString(header);
}

function extractTokenFromHeaders(req: IncomingMessage): string | undefined {
  const explicit =
    headerValue(req.headers["x-synology-token"]) ??
    headerValue(req.headers["x-webhook-token"]) ??
    headerValue(req.headers["x-openclaw-token"]);
  if (explicit) return explicit;

  const auth = headerValue(req.headers.authorization);
  if (!auth) return undefined;

  const bearerMatch = auth.match(/^Bearer\s+(.+)$/i);
  if (bearerMatch?.[1]) return bearerMatch[1].trim();
  return auth.trim();
}

/**
 * Parse/normalize incoming webhook payload.
 *
 * Supports:
 * - application/x-www-form-urlencoded
 * - application/json
 *
 * Token resolution order: body.token -> query.token -> headers
 * Field aliases:
 * - user_id <- user_id | userId | user
 * - text    <- text | message | content
 */
function parsePayload(req: IncomingMessage, body: string): SynologyWebhookPayload | null {
  const contentType = String(req.headers["content-type"] ?? "").toLowerCase();

  let bodyFields: Record<string, unknown> = {};
  if (contentType.includes("application/json")) {
    bodyFields = parseJsonBody(body);
  } else if (contentType.includes("application/x-www-form-urlencoded")) {
    bodyFields = parseFormBody(body);
  } else {
    // Fallback for clients with missing/incorrect content-type.
    // Try JSON first, then form-urlencoded.
    try {
      bodyFields = parseJsonBody(body);
    } catch {
      bodyFields = parseFormBody(body);
    }
  }

  const queryFields = parseQueryParams(req);
  const headerToken = extractTokenFromHeaders(req);

  const token =
    pickAlias(bodyFields, ["token"]) ?? pickAlias(queryFields, ["token"]) ?? headerToken;
  const userId =
    pickAlias(bodyFields, ["user_id", "userId", "user"]) ??
    pickAlias(queryFields, ["user_id", "userId", "user"]);
  const text =
    pickAlias(bodyFields, ["text", "message", "content"]) ??
    pickAlias(queryFields, ["text", "message", "content"]);

  if (!token || !userId || !text) return null;

  return {
    token,
    channel_id:
      pickAlias(bodyFields, ["channel_id"]) ?? pickAlias(queryFields, ["channel_id"]) ?? undefined,
    channel_name:
      pickAlias(bodyFields, ["channel_name"]) ??
      pickAlias(queryFields, ["channel_name"]) ??
      undefined,
    user_id: userId,
    username:
      pickAlias(bodyFields, ["username", "user_name", "name"]) ??
      pickAlias(queryFields, ["username", "user_name", "name"]) ??
      "unknown",
    post_id: pickAlias(bodyFields, ["post_id"]) ?? pickAlias(queryFields, ["post_id"]) ?? undefined,
    timestamp:
      pickAlias(bodyFields, ["timestamp"]) ?? pickAlias(queryFields, ["timestamp"]) ?? undefined,
    text,
    trigger_word:
      pickAlias(bodyFields, ["trigger_word", "triggerWord"]) ??
      pickAlias(queryFields, ["trigger_word", "triggerWord"]) ??
      undefined,
  };
}

/** Send a JSON response. */
function respondJson(res: ServerResponse, statusCode: number, body: Record<string, unknown>) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Send a no-content ACK. */
function respondNoContent(res: ServerResponse) {
  res.writeHead(204);
  res.end();
}

export interface WebhookHandlerDeps {
  account: ResolvedSynologyChatAccount;
  deliver: (msg: {
    body: string;
    from: string;
    senderName: string;
    provider: string;
    chatType: string;
    sessionKey: string;
    accountId: string;
    /** Chat API user_id for sending replies (may differ from webhook user_id) */
    chatUserId?: string;
  }) => Promise<string | null>;
  log?: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}

/**
 * Create an HTTP request handler for Synology Chat outgoing webhooks.
 *
 * This handler:
 * 1. Parses form-urlencoded/JSON payload
 * 2. Validates token (constant-time)
 * 3. Checks user allowlist
 * 4. Checks rate limit
 * 5. Sanitizes input
 * 6. Immediately ACKs request (204)
 * 7. Delivers to the agent asynchronously and sends final reply via incomingUrl
 */
export function createWebhookHandler(deps: WebhookHandlerDeps) {
  const { account, deliver, log } = deps;
  const rateLimiter = getRateLimiter(account);

  return async (req: IncomingMessage, res: ServerResponse) => {
    // Only accept POST
    if (req.method !== "POST") {
      respondJson(res, 405, { error: "Method not allowed" });
      return;
    }

    // Parse body
    const bodyResult = await readBody(req);
    if (!bodyResult.ok) {
      log?.error("Failed to read request body", bodyResult.error);
      respondJson(res, bodyResult.statusCode, { error: bodyResult.error });
      return;
    }

    // Parse payload
    let payload: SynologyWebhookPayload | null = null;
    try {
      payload = parsePayload(req, bodyResult.body);
    } catch (err) {
      log?.warn("Failed to parse webhook payload", err);
      respondJson(res, 400, { error: "Invalid request body" });
      return;
    }
    if (!payload) {
      respondJson(res, 400, { error: "Missing required fields (token, user_id, text)" });
      return;
    }

    // Token validation
    if (!validateToken(payload.token, account.token)) {
      log?.warn(`Invalid token from ${req.socket?.remoteAddress}`);
      respondJson(res, 401, { error: "Invalid token" });
      return;
    }

    // DM policy authorization
    const auth = authorizeUserForDm(payload.user_id, account.dmPolicy, account.allowedUserIds);
    if (!auth.allowed) {
      if (auth.reason === "disabled") {
        respondJson(res, 403, { error: "DMs are disabled" });
        return;
      }
      if (auth.reason === "allowlist-empty") {
        log?.warn("Synology Chat allowlist is empty while dmPolicy=allowlist; rejecting message");
        respondJson(res, 403, {
          error: "Allowlist is empty. Configure allowedUserIds or use dmPolicy=open.",
        });
        return;
      }
      log?.warn(`Unauthorized user: ${payload.user_id}`);
      respondJson(res, 403, { error: "User not authorized" });
      return;
    }

    // Rate limit
    if (!rateLimiter.check(payload.user_id)) {
      log?.warn(`Rate limit exceeded for user: ${payload.user_id}`);
      respondJson(res, 429, { error: "Rate limit exceeded" });
      return;
    }

    // Sanitize input
    let cleanText = sanitizeInput(payload.text);

    // Strip trigger word
    if (payload.trigger_word && cleanText.startsWith(payload.trigger_word)) {
      cleanText = cleanText.slice(payload.trigger_word.length).trim();
    }

    if (!cleanText) {
      respondNoContent(res);
      return;
    }

    const preview = cleanText.length > 100 ? `${cleanText.slice(0, 100)}...` : cleanText;
    log?.info(`Message from ${payload.username} (${payload.user_id}): ${preview}`);

    // ACK immediately so Synology Chat won't remain in "Processing..."
    respondNoContent(res);

    // Default to webhook user_id; may be replaced with Chat API user_id below.
    let replyUserId = payload.user_id;

    // Deliver to agent asynchronously (with 120s timeout to match nginx proxy_read_timeout)
    try {
      // Resolve the Chat-internal user_id for sending replies.
      // Synology Chat outgoing webhooks use a per-integration user_id that may
      // differ from the global Chat API user_id required by method=chatbot.
      // We resolve via the user_list API, matching by nickname/username.
      const chatUserId = await resolveChatUserId(
        account.incomingUrl,
        payload.username,
        account.allowInsecureSsl,
        log,
      );
      if (chatUserId !== undefined) {
        replyUserId = String(chatUserId);
      } else {
        log?.warn(
          `Could not resolve Chat API user_id for "${payload.username}" — falling back to webhook user_id ${payload.user_id}. Reply delivery may fail.`,
        );
      }

      const sessionKey = `synology-chat-${payload.user_id}`;
      const deliverPromise = deliver({
        body: cleanText,
        from: payload.user_id,
        senderName: payload.username,
        provider: "synology-chat",
        chatType: "direct",
        sessionKey,
        accountId: account.accountId,
        chatUserId: replyUserId,
      });

      const timeoutPromise = new Promise<null>((_, reject) =>
        setTimeout(() => reject(new Error("Agent response timeout (120s)")), 120_000),
      );

      const reply = await Promise.race([deliverPromise, timeoutPromise]);

      // Send reply back to Synology Chat using the resolved Chat user_id
      if (reply) {
        await sendMessage(account.incomingUrl, reply, replyUserId, account.allowInsecureSsl);
        const replyPreview = reply.length > 100 ? `${reply.slice(0, 100)}...` : reply;
        log?.info(`Reply sent to ${payload.username} (${replyUserId}): ${replyPreview}`);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
      log?.error(`Failed to process message from ${payload.username}: ${errMsg}`);
      await sendMessage(
        account.incomingUrl,
        "Sorry, an error occurred while processing your message.",
        replyUserId,
        account.allowInsecureSsl,
      );
    }
  };
}
