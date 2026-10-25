import type { IncomingMessage, ServerResponse } from "node:http";
import * as querystring from "node:querystring";
import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import { writeJsonWithoutCharset as respondJson } from "openclaw/plugin-sdk/http-response-runtime";
import {
  asOptionalRecord,
  normalizeLowercaseStringOrEmpty,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { safeParseJson } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  beginWebhookRequestPipelineOrReject,
  createFixedWindowRateLimiter,
  createWebhookInFlightLimiter,
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  resolveRequestClientIp,
  requestBodyErrorToText,
  type FixedWindowRateLimiter,
} from "openclaw/plugin-sdk/webhook-ingress";
import { sendHttpRequestRejection } from "openclaw/plugin-sdk/webhook-request-guards";
import * as synologyClient from "./client.js";
import type { SynologyInboundMessage } from "./inbound-context.js";
import { validateToken, authorizeUserForDmWithIngress, sanitizeInput } from "./security.js";
import type { SynologyWebhookPayload, ResolvedSynologyChatAccount } from "./types.js";
import {
  SynologyIngressPermanentError,
  firstNonEmptyString,
  type SynologyIngressLifecycle,
  type SynologyIngressMonitor,
  type SynologyWebhookRawEvent,
} from "./webhook-ingress.js";

const rateLimiters = new Map<string, { limit: number; limiter: FixedWindowRateLimiter }>();
const invalidTokenRateLimiters = new Map<string, InvalidTokenRateLimiter>();
const webhookInFlightLimiter = createWebhookInFlightLimiter();
const PREAUTH_MAX_BODY_BYTES = 64 * 1024;
const PREAUTH_BODY_TIMEOUT_MS = 5_000;
const PREAUTH_MAX_REQUESTS_PER_MINUTE = 10;
const INVALID_TOKEN_WINDOW_MS = 60_000;
const INVALID_TOKEN_MAX_TRACKED_KEYS = 5_000;

type InvalidTokenRateLimitState = {
  count: number;
  windowStartMs: number;
};

class InvalidTokenRateLimiter {
  private readonly state = new Map<string, InvalidTokenRateLimitState>();

  constructor(readonly limit: number) {}

  private normalizeState(key: string, nowMs: number): InvalidTokenRateLimitState | undefined {
    const existing = this.state.get(key);
    if (!existing) {
      return undefined;
    }
    if (nowMs - existing.windowStartMs >= INVALID_TOKEN_WINDOW_MS) {
      this.state.delete(key);
      return undefined;
    }
    return existing;
  }

  isLocked(key: string): boolean {
    if (!key) {
      return false;
    }
    const existing = this.normalizeState(key, Date.now());
    return (existing?.count ?? 0) > this.limit;
  }

  recordFailure(key: string): boolean {
    if (!key) {
      return false;
    }
    const nowMs = Date.now();
    const existing = this.normalizeState(key, nowMs);
    const nextCount = (existing?.count ?? 0) + 1;
    const windowStartMs = existing?.windowStartMs ?? nowMs;
    this.state.delete(key);
    this.state.set(key, { count: nextCount, windowStartMs });
    pruneMapToMaxSize(this.state, INVALID_TOKEN_MAX_TRACKED_KEYS);
    return nextCount > this.limit;
  }

  clear(): void {
    this.state.clear();
  }
}

function pickAlias(record: Record<string, unknown>, aliases: string[]): string | undefined {
  for (const alias of aliases) {
    const normalized = firstNonEmptyString(record[alias]);
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
}

function parseJsonBody(body: string): Record<string, unknown> {
  if (!body.trim()) {
    return {};
  }
  const parsed = asOptionalRecord(safeParseJson(body));
  if (!parsed) {
    throw new Error("Invalid JSON body");
  }
  return parsed;
}

function extractTokenFromHeaders(req: IncomingMessage): string | undefined {
  const explicit =
    firstNonEmptyString(req.headers["x-synology-token"]) ??
    firstNonEmptyString(req.headers["x-webhook-token"]) ??
    firstNonEmptyString(req.headers["x-openclaw-token"]);
  if (explicit) {
    return explicit;
  }

  const auth = firstNonEmptyString(req.headers.authorization);
  if (!auth) {
    return undefined;
  }

  const bearerMatch = auth.match(/^Bearer\s+(.+)$/i);
  if (bearerMatch?.[1]) {
    return bearerMatch[1].trim();
  }
  return auth;
}

function parsePayload(
  rawEvent: SynologyWebhookRawEvent,
  token: string | undefined,
): SynologyWebhookPayload | null {
  const { bodyFields, queryFields } = rawEvent;

  const field = (...aliases: string[]) =>
    pickAlias(bodyFields, aliases) ?? pickAlias(queryFields, aliases);
  const userId = field("user_id", "userId", "user");
  const text = field("text", "message", "content");

  if (!token || !userId || !text) {
    return null;
  }

  return {
    token,
    channel_id: field("channel_id"),
    channel_name: field("channel_name"),
    user_id: userId,
    username: field("username", "user_name", "name") ?? "unknown",
    post_id: field("post_id"),
    timestamp: field("timestamp"),
    text,
    trigger_word: field("trigger_word", "triggerWord"),
  };
}

const SYNOLOGY_WEBHOOK_ACCEPTED_HEADER = "x-openclaw-delivery-accepted";
const SYNOLOGY_WEBHOOK_ACCEPTED_VALUE = "durable";

export interface WebhookHandlerDeps {
  account: ResolvedSynologyChatAccount;
  receive: SynologyIngressMonitor["receive"];
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  log?: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  bodyTimeoutMs?: number;
}

export async function processSynologyWebhookIngressEvent(params: {
  account: ResolvedSynologyChatAccount;
  deliver: (msg: SynologyInboundMessage, lifecycle: SynologyIngressLifecycle) => Promise<unknown>;
  log?: WebhookHandlerDeps["log"];
  rawEvent: SynologyWebhookRawEvent;
  lifecycle: SynologyIngressLifecycle;
}): Promise<void> {
  const payload = parsePayload(params.rawEvent, params.account.token);
  if (!payload || !payload.post_id) {
    throw new SynologyIngressPermanentError(
      "invalid-event",
      "Synology Chat claimed webhook cannot be normalized.",
    );
  }
  const resolveChannelIngress = async (
    contextBinding?: import("openclaw/plugin-sdk/channel-ingress-runtime").ChannelIngressContextBinding,
  ) => {
    const auth = await authorizeUserForDmWithIngress({
      accountId: params.account.accountId,
      userId: payload.user_id,
      dmPolicy: params.account.dmPolicy,
      allowedUserIds: params.account.allowedUserIds,
      contextBinding,
    });
    if (!auth.senderAccess.allowed) {
      throw new SynologyIngressPermanentError(
        "synology-auth",
        `Synology Chat user ${payload.user_id} is no longer authorized.`,
      );
    }
    return auth;
  };
  const channelIngress = await resolveChannelIngress();
  let body = sanitizeInput(payload.text);
  if (payload.trigger_word && body.startsWith(payload.trigger_word)) {
    body = body.slice(payload.trigger_word.length).trim();
  }
  if (!body) {
    return;
  }
  params.log?.info?.(`Message from ${payload.username} (${payload.user_id}): len=${body.length}`);

  const authorizedWebhookUserId = payload.user_id;
  const { account, log } = params;
  const deliveryUserId = await (async () => {
    if (!account.dangerouslyAllowNameMatching) {
      return payload.user_id;
    }

    const resolvedChatApiUserId = await synologyClient.resolveLegacyWebhookNameToChatUserId({
      incomingUrl: account.incomingUrl,
      mutableWebhookUsername: payload.username,
      allowInsecureSsl: account.allowInsecureSsl,
      log,
    });
    if (resolvedChatApiUserId !== undefined) {
      return String(resolvedChatApiUserId);
    }
    log?.warn(
      `Could not resolve Chat API user_id for "${payload.username}" — falling back to webhook user_id ${payload.user_id}. Reply delivery may fail.`,
    );
    return payload.user_id;
  })();
  await params.deliver(
    {
      body,
      resolveChannelIngress,
      messageId: payload.post_id,
      from: authorizedWebhookUserId,
      senderName: payload.username,
      chatType: "direct",
      commandAuthorized: channelIngress.senderAccess.allowed,
      chatUserId: deliveryUserId,
    },
    params.lifecycle,
  );
}

export function createWebhookHandler(deps: WebhookHandlerDeps) {
  const { account, log } = deps;
  let rateLimiterEntry = rateLimiters.get(account.accountId);
  if (!rateLimiterEntry || rateLimiterEntry.limit !== account.rateLimitPerMinute) {
    rateLimiterEntry?.limiter.clear();
    rateLimiterEntry = {
      limit: account.rateLimitPerMinute,
      limiter: createFixedWindowRateLimiter({
        windowMs: 60_000,
        maxRequests: Math.max(1, Math.floor(account.rateLimitPerMinute)),
        maxTrackedKeys: 5_000,
      }),
    };
    rateLimiters.set(account.accountId, rateLimiterEntry);
  }
  const rateLimiter = rateLimiterEntry.limiter;
  const limit = Math.min(account.rateLimitPerMinute, PREAUTH_MAX_REQUESTS_PER_MINUTE);
  let invalidTokenLimiterEntry = invalidTokenRateLimiters.get(account.accountId);
  if (!invalidTokenLimiterEntry || invalidTokenLimiterEntry.limit !== limit) {
    invalidTokenLimiterEntry?.clear();
    invalidTokenLimiterEntry = new InvalidTokenRateLimiter(limit);
    invalidTokenRateLimiters.set(account.accountId, invalidTokenLimiterEntry);
  }
  const invalidTokenRateLimiter = invalidTokenLimiterEntry;

  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") {
      respondJson(res, 405, { error: "Method not allowed" });
      return;
    }
    const requestLifecycle = beginWebhookRequestPipelineOrReject({
      req,
      res,
      inFlightLimiter: webhookInFlightLimiter,
      // Bound pre-auth body reads per account; invalid-token limits own client identity.
      inFlightKey: account.accountId,
    });
    if (!requestLifecycle.ok) {
      return;
    }

    let rawEvent: SynologyWebhookRawEvent;
    try {
      const bodyTimeoutMs = deps.bodyTimeoutMs;
      let body: string;
      try {
        body = await readRequestBodyWithLimit(req, {
          maxBytes: PREAUTH_MAX_BODY_BYTES,
          timeoutMs: bodyTimeoutMs === undefined ? PREAUTH_BODY_TIMEOUT_MS : bodyTimeoutMs,
          // Defer destruction so the rejection owner can flush its response before closing.
          destroyOnLimit: false,
        });
      } catch (err) {
        const limited = isRequestBodyLimitError(err);
        const error = limited ? requestBodyErrorToText(err.code) : "Invalid request body";
        log?.error("Failed to read request body", error);
        if (limited) {
          await sendHttpRequestRejection(
            req,
            res,
            err.statusCode,
            JSON.stringify({ error }),
            "application/json",
          );
          return;
        }
        respondJson(res, 400, { error });
        return;
      }

      let parsedRawEvent: SynologyWebhookRawEvent;
      let parsedToken: string | undefined;
      try {
        // Token precedence is body, query, then headers.
        const contentType = normalizeLowercaseStringOrEmpty(req.headers["content-type"]);

        let bodyFields: Record<string, unknown>;
        if (contentType.includes("application/json")) {
          bodyFields = parseJsonBody(body);
        } else if (contentType.includes("application/x-www-form-urlencoded")) {
          bodyFields = querystring.parse(body);
        } else {
          // Fallback for clients with missing/incorrect content-type.
          // Try JSON first, then form-urlencoded.
          try {
            bodyFields = parseJsonBody(body);
          } catch {
            bodyFields = querystring.parse(body);
          }
        }

        let queryFields: Record<string, unknown>;
        try {
          const url = new URL(req.url ?? "", "http://localhost");
          queryFields = {};
          for (const [key, value] of url.searchParams.entries()) {
            queryFields[key] = value;
          }
        } catch {
          queryFields = {};
        }
        const headerToken = extractTokenFromHeaders(req);

        parsedRawEvent = { bodyFields, queryFields };
        parsedToken =
          pickAlias(bodyFields, ["token"]) ?? pickAlias(queryFields, ["token"]) ?? headerToken;
      } catch (err) {
        log?.warn("Failed to parse webhook payload", err);
        respondJson(res, 400, { error: "Invalid request body" });
        return;
      }
      const payload = parsePayload(parsedRawEvent, parsedToken);
      if (!payload) {
        respondJson(res, 400, { error: "Missing required fields (token, user_id, text)" });
        return;
      }
      const { trustedProxies, allowRealIpFallback } = deps;
      const invalidTokenRateLimitKey =
        resolveRequestClientIp(req, trustedProxies, allowRealIpFallback === true) ??
        req.socket?.remoteAddress ??
        "unknown";
      // Once a source has exhausted its invalid-token budget, reject all requests in the window.
      if (invalidTokenRateLimiter.isLocked(invalidTokenRateLimitKey)) {
        log?.warn(`Rate limit exceeded for remote IP: ${invalidTokenRateLimitKey}`);
        respondJson(res, 429, { error: "Rate limit exceeded" });
        return;
      }

      if (!validateToken(payload.token, account.token)) {
        if (invalidTokenRateLimiter.recordFailure(invalidTokenRateLimitKey)) {
          log?.warn(`Rate limit exceeded for remote IP: ${invalidTokenRateLimitKey}`);
          respondJson(res, 429, { error: "Rate limit exceeded" });
          return;
        }
        log?.warn(`Invalid token from ${req.socket?.remoteAddress}`);
        respondJson(res, 401, { error: "Invalid token" });
        return;
      }

      const auth = await authorizeUserForDmWithIngress({
        accountId: account.accountId,
        userId: payload.user_id,
        dmPolicy: account.dmPolicy,
        allowedUserIds: account.allowedUserIds,
      });
      if (!auth.senderAccess.allowed) {
        if (auth.senderAccess.reasonCode === "dm_policy_disabled") {
          respondJson(res, 403, { error: "DMs are disabled" });
          return;
        }
        if (account.dmPolicy === "allowlist" && account.allowedUserIds.length === 0) {
          log?.warn("Synology Chat allowlist is empty while dmPolicy=allowlist; rejecting message");
          respondJson(res, 403, {
            error:
              'Allowlist is empty. Configure allowedUserIds or use dmPolicy=open with allowedUserIds=["*"].',
          });
          return;
        }
        log?.warn(`Unauthorized user: ${payload.user_id}`);
        respondJson(res, 403, { error: "User not authorized" });
        return;
      }

      if (rateLimiter.isRateLimited(payload.user_id)) {
        // Keep a separate post-auth budget so authenticated users are still throttled per sender.
        log?.warn(`Rate limit exceeded for user: ${payload.user_id}`);
        respondJson(res, 429, { error: "Rate limit exceeded" });
        return;
      }
      rawEvent = parsedRawEvent;
    } finally {
      // Only bound the pre-auth request pipeline; async reply delivery is outside webhook ingress.
      requestLifecycle.release();
    }

    let admitted: Awaited<ReturnType<SynologyIngressMonitor["receive"]>>;
    try {
      admitted = await deps.receive(rawEvent);
    } catch (error) {
      log?.error?.("Failed to durably admit Synology Chat webhook", error);
      respondJson(res, 503, { error: "Webhook admission failed" });
      return;
    }
    if (admitted.kind === "invalid") {
      respondJson(res, 400, { error: admitted.message });
      return;
    }
    // Only a durably admitted event is acknowledged here; mark the ack so
    // proxies can distinguish it from other responses (same marker as #104407).
    res.setHeader(SYNOLOGY_WEBHOOK_ACCEPTED_HEADER, SYNOLOGY_WEBHOOK_ACCEPTED_VALUE);
    res.writeHead(204);
    res.end();
  };
}
