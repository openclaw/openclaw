import * as querystring from "node:querystring";
import {
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  requestBodyErrorToText
} from "openclaw/plugin-sdk/synology-chat";
import { sendMessage, resolveChatUserId } from "./client.js";
import { validateToken, authorizeUserForDm, sanitizeInput, RateLimiter } from "./security.js";
const rateLimiters = /* @__PURE__ */ new Map();
function getRateLimiter(account) {
  let rl = rateLimiters.get(account.accountId);
  if (!rl || rl.maxRequests() !== account.rateLimitPerMinute) {
    rl?.clear();
    rl = new RateLimiter(account.rateLimitPerMinute);
    rateLimiters.set(account.accountId, rl);
  }
  return rl;
}
function clearSynologyWebhookRateLimiterStateForTest() {
  for (const limiter of rateLimiters.values()) {
    limiter.clear();
  }
  rateLimiters.clear();
}
function getSynologyWebhookRateLimiterCountForTest() {
  return rateLimiters.size;
}
async function readBody(req) {
  try {
    const body = await readRequestBodyWithLimit(req, {
      maxBytes: 1048576,
      timeoutMs: 3e4
    });
    return { ok: true, body };
  } catch (err) {
    if (isRequestBodyLimitError(err)) {
      return {
        ok: false,
        statusCode: err.statusCode,
        error: requestBodyErrorToText(err.code)
      };
    }
    return {
      ok: false,
      statusCode: 400,
      error: "Invalid request body"
    };
  }
}
function firstNonEmptyString(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const normalized = firstNonEmptyString(item);
      if (normalized) return normalized;
    }
    return void 0;
  }
  if (value === null || value === void 0) return void 0;
  const str = String(value).trim();
  return str.length > 0 ? str : void 0;
}
function pickAlias(record, aliases) {
  for (const alias of aliases) {
    const normalized = firstNonEmptyString(record[alias]);
    if (normalized) return normalized;
  }
  return void 0;
}
function parseQueryParams(req) {
  try {
    const url = new URL(req.url ?? "", "http://localhost");
    const out = {};
    for (const [key, value] of url.searchParams.entries()) {
      out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}
function parseFormBody(body) {
  return querystring.parse(body);
}
function parseJsonBody(body) {
  if (!body.trim()) return {};
  const parsed = JSON.parse(body);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("Invalid JSON body");
  }
  return parsed;
}
function headerValue(header) {
  return firstNonEmptyString(header);
}
function extractTokenFromHeaders(req) {
  const explicit = headerValue(req.headers["x-synology-token"]) ?? headerValue(req.headers["x-webhook-token"]) ?? headerValue(req.headers["x-openclaw-token"]);
  if (explicit) return explicit;
  const auth = headerValue(req.headers.authorization);
  if (!auth) return void 0;
  const bearerMatch = auth.match(/^Bearer\s+(.+)$/i);
  if (bearerMatch?.[1]) return bearerMatch[1].trim();
  return auth.trim();
}
function parsePayload(req, body) {
  const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
  let bodyFields = {};
  if (contentType.includes("application/json")) {
    bodyFields = parseJsonBody(body);
  } else if (contentType.includes("application/x-www-form-urlencoded")) {
    bodyFields = parseFormBody(body);
  } else {
    try {
      bodyFields = parseJsonBody(body);
    } catch {
      bodyFields = parseFormBody(body);
    }
  }
  const queryFields = parseQueryParams(req);
  const headerToken = extractTokenFromHeaders(req);
  const token = pickAlias(bodyFields, ["token"]) ?? pickAlias(queryFields, ["token"]) ?? headerToken;
  const userId = pickAlias(bodyFields, ["user_id", "userId", "user"]) ?? pickAlias(queryFields, ["user_id", "userId", "user"]);
  const text = pickAlias(bodyFields, ["text", "message", "content"]) ?? pickAlias(queryFields, ["text", "message", "content"]);
  if (!token || !userId || !text) return null;
  return {
    token,
    channel_id: pickAlias(bodyFields, ["channel_id"]) ?? pickAlias(queryFields, ["channel_id"]) ?? void 0,
    channel_name: pickAlias(bodyFields, ["channel_name"]) ?? pickAlias(queryFields, ["channel_name"]) ?? void 0,
    user_id: userId,
    username: pickAlias(bodyFields, ["username", "user_name", "name"]) ?? pickAlias(queryFields, ["username", "user_name", "name"]) ?? "unknown",
    post_id: pickAlias(bodyFields, ["post_id"]) ?? pickAlias(queryFields, ["post_id"]) ?? void 0,
    timestamp: pickAlias(bodyFields, ["timestamp"]) ?? pickAlias(queryFields, ["timestamp"]) ?? void 0,
    text,
    trigger_word: pickAlias(bodyFields, ["trigger_word", "triggerWord"]) ?? pickAlias(queryFields, ["trigger_word", "triggerWord"]) ?? void 0
  };
}
function respondJson(res, statusCode, body) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
function respondNoContent(res) {
  res.writeHead(204);
  res.end();
}
function createWebhookHandler(deps) {
  const { account, deliver, log } = deps;
  const rateLimiter = getRateLimiter(account);
  return async (req, res) => {
    if (req.method !== "POST") {
      respondJson(res, 405, { error: "Method not allowed" });
      return;
    }
    const bodyResult = await readBody(req);
    if (!bodyResult.ok) {
      log?.error("Failed to read request body", bodyResult.error);
      respondJson(res, bodyResult.statusCode, { error: bodyResult.error });
      return;
    }
    let payload = null;
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
    if (!validateToken(payload.token, account.token)) {
      log?.warn(`Invalid token from ${req.socket?.remoteAddress}`);
      respondJson(res, 401, { error: "Invalid token" });
      return;
    }
    const auth = authorizeUserForDm(payload.user_id, account.dmPolicy, account.allowedUserIds);
    if (!auth.allowed) {
      if (auth.reason === "disabled") {
        respondJson(res, 403, { error: "DMs are disabled" });
        return;
      }
      if (auth.reason === "allowlist-empty") {
        log?.warn("Synology Chat allowlist is empty while dmPolicy=allowlist; rejecting message");
        respondJson(res, 403, {
          error: "Allowlist is empty. Configure allowedUserIds or use dmPolicy=open."
        });
        return;
      }
      log?.warn(`Unauthorized user: ${payload.user_id}`);
      respondJson(res, 403, { error: "User not authorized" });
      return;
    }
    if (!rateLimiter.check(payload.user_id)) {
      log?.warn(`Rate limit exceeded for user: ${payload.user_id}`);
      respondJson(res, 429, { error: "Rate limit exceeded" });
      return;
    }
    let cleanText = sanitizeInput(payload.text);
    if (payload.trigger_word && cleanText.startsWith(payload.trigger_word)) {
      cleanText = cleanText.slice(payload.trigger_word.length).trim();
    }
    if (!cleanText) {
      respondNoContent(res);
      return;
    }
    const preview = cleanText.length > 100 ? `${cleanText.slice(0, 100)}...` : cleanText;
    log?.info(`Message from ${payload.username} (${payload.user_id}): ${preview}`);
    respondNoContent(res);
    let replyUserId = payload.user_id;
    try {
      const chatUserId = await resolveChatUserId(
        account.incomingUrl,
        payload.username,
        account.allowInsecureSsl,
        log
      );
      if (chatUserId !== void 0) {
        replyUserId = String(chatUserId);
      } else {
        log?.warn(
          `Could not resolve Chat API user_id for "${payload.username}" \u2014 falling back to webhook user_id ${payload.user_id}. Reply delivery may fail.`
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
        commandAuthorized: auth.allowed,
        chatUserId: replyUserId
      });
      const timeoutPromise = new Promise(
        (_, reject) => setTimeout(() => reject(new Error("Agent response timeout (120s)")), 12e4)
      );
      const reply = await Promise.race([deliverPromise, timeoutPromise]);
      if (reply) {
        await sendMessage(account.incomingUrl, reply, replyUserId, account.allowInsecureSsl);
        const replyPreview = reply.length > 100 ? `${reply.slice(0, 100)}...` : reply;
        log?.info(`Reply sent to ${payload.username} (${replyUserId}): ${replyPreview}`);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? `${err.message}
${err.stack}` : String(err);
      log?.error(`Failed to process message from ${payload.username}: ${errMsg}`);
      await sendMessage(
        account.incomingUrl,
        "Sorry, an error occurred while processing your message.",
        replyUserId,
        account.allowInsecureSsl
      );
    }
  };
}
export {
  clearSynologyWebhookRateLimiterStateForTest,
  createWebhookHandler,
  getSynologyWebhookRateLimiterCountForTest
};
