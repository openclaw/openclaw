// Rcs plugin module implements webhook behavior.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { fetchConfiguredLocalOriginWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime-internal";
import { readRequestBodyWithLimit } from "openclaw/plugin-sdk/webhook-ingress";
import { isRcsWireAddress, normalizeRcsIdentity } from "./address.js";
import { recordRcsStatusEvent } from "./status-store.js";
import {
  buildTwilioInboundMessage,
  buildTwilioStatusEvent,
  parseTwilioFormBody,
  readTwilioWebhookForm,
  resolveRcsStatusCallbackUrl,
  respondTwiml,
  resolveTwilioWebhookSignatureUrl,
  verifyTwilioSignature,
} from "./twilio.js";
import type { ResolvedRcsAccount } from "./types.js";
import {
  createInboundIpRateLimiter,
  createInboundSenderRateLimiter,
  createStatusRateLimiter,
  type RcsWebhookRateLimiter,
} from "./webhook-state.js";

const SHARED_SMS_FORWARD_TIMEOUT_MS = 10_000;
const SHARED_WEBHOOK_BODY_LIMIT_BYTES = 64 * 1024;
const SHARED_WEBHOOK_BODY_TIMEOUT_MS = 5_000;

type RcsWebhookHandlerDeps = {
  ipRateLimiter?: RcsWebhookRateLimiter;
  senderRateLimiter?: RcsWebhookRateLimiter;
};

type RcsWebhookLog = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

export type RcsWebhookHandlerParams = {
  cfg: OpenClawConfig;
  account: ResolvedRcsAccount;
  ingress: {
    enqueue: (form: Record<string, string>) => Promise<{ duplicate: boolean }>;
  };
  log?: RcsWebhookLog;
};

type RcsStatusCallbackHandlerParams = Omit<RcsWebhookHandlerParams, "ingress">;

type RcsSharedWebhookHandlerParams = RcsWebhookHandlerParams & {
  sharedPublicWebhookUrl: string;
  smsForwardWebhookPath: string;
};

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function rateLimitKey(req: IncomingMessage): string {
  return req.socket?.remoteAddress ?? "unknown";
}

function rejectRateLimitedRequest(params: {
  scope: string;
  key: string;
  log?: RcsWebhookLog;
  res: ServerResponse;
}): true {
  params.log?.warn?.(`${params.scope} rate limit exceeded for ${params.key}`);
  respondTwiml(params.res, 429, "Rate limit exceeded");
  return true;
}

function requestSearch(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? "/", "http://localhost").search;
  } catch {
    return "";
  }
}

function normalizeWebhookPath(path: string): string {
  const trimmed = path.trim();
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function formLooksRcs(form: Record<string, string>): boolean {
  return isRcsWireAddress(form.From ?? "") || isRcsWireAddress(form.To ?? "");
}

function verifyWebhookSignature(params: {
  req: IncomingMessage;
  form: Record<string, string>;
  account: ResolvedRcsAccount;
  signatureUrl: string;
}): boolean {
  return verifyTwilioSignature({
    signature: headerValue(params.req.headers["x-twilio-signature"]),
    url: params.signatureUrl,
    authToken: params.account.authToken,
    form: params.form,
  });
}

async function dispatchVerifiedRcsForm(params: {
  account: ResolvedRcsAccount;
  ingress: RcsWebhookHandlerParams["ingress"];
  form: Record<string, string>;
  res: ServerResponse;
  log?: RcsWebhookLog;
  scope: string;
  rateLimited: boolean;
  rateLimitedKey: string;
  senderRateLimiter: RcsWebhookRateLimiter;
}): Promise<void> {
  const msg = buildTwilioInboundMessage(params.form);
  if (!msg) {
    if (params.rateLimited) {
      rejectRateLimitedRequest({
        scope: params.scope,
        key: params.rateLimitedKey,
        log: params.log,
        res: params.res,
      });
      return;
    }
    respondTwiml(params.res, 400, "Missing RCS payload");
    return;
  }
  if (msg.accountSid && msg.accountSid !== params.account.accountSid) {
    if (params.rateLimited) {
      rejectRateLimitedRequest({
        scope: params.scope,
        key: params.rateLimitedKey,
        log: params.log,
        res: params.res,
      });
      return;
    }
    params.log?.warn?.("RCS webhook rejected mismatched Twilio AccountSid");
    respondTwiml(params.res, 403, "Invalid account");
    return;
  }
  if (params.rateLimited) {
    if (params.account.dangerouslyDisableSignatureValidation) {
      // Without signature validation nothing distinguishes Twilio from an attacker,
      // so unauthenticated over-limit traffic keeps the fail-closed 429.
      rejectRateLimitedRequest({
        scope: params.scope,
        key: params.rateLimitedKey,
        log: params.log,
        res: params.res,
      });
      return;
    }
    params.log?.warn?.(
      `${params.scope} rate limit exceeded for ${params.rateLimitedKey}; acknowledged validated callback ${msg.messageSid} without dispatch`,
    );
    respondTwiml(params.res, 200);
    return;
  }
  const senderKey = normalizeRcsIdentity(msg.from);
  if (
    senderKey &&
    params.senderRateLimiter.isRateLimited(`${params.account.accountId}:${senderKey}`)
  ) {
    params.log?.warn?.(`RCS webhook sender rate limit exceeded for ${senderKey}`);
    // Twilio does not retry messaging webhooks on non-2xx; acknowledge and drop so
    // one hot sender cannot turn rate limiting into webhook failure noise.
    respondTwiml(params.res, 200);
    return;
  }

  const verdict = await params.ingress.enqueue(params.form);
  if (verdict.duplicate) {
    params.log?.warn?.(`RCS webhook ignored replayed message ${msg.messageSid}`);
  }
  respondTwiml(params.res, 200);
}

async function forwardSharedSmsWebhook(params: {
  req: IncomingMessage;
  res: ServerResponse;
  body: string;
  smsForwardWebhookPath: string;
  log?: RcsWebhookLog;
}): Promise<void> {
  const localPort = params.req.socket.localPort;
  if (!localPort) {
    params.log?.error?.("RCS shared webhook could not determine local gateway port");
    respondTwiml(params.res, 502, "Gateway forwarding unavailable");
    return;
  }
  const forwardPath = `${normalizeWebhookPath(params.smsForwardWebhookPath)}${requestSearch(params.req)}`;
  const localOriginBaseUrl = `http://127.0.0.1:${localPort}`;
  const forwardUrl = `${localOriginBaseUrl}${forwardPath}`;
  let guarded: Awaited<ReturnType<typeof fetchConfiguredLocalOriginWithSsrFGuard>>;
  try {
    guarded = await fetchConfiguredLocalOriginWithSsrFGuard({
      url: forwardUrl,
      configuredLocalOriginBaseUrl: localOriginBaseUrl,
      auditContext: "rcs-shared-webhook-sms-forward",
      timeoutMs: SHARED_SMS_FORWARD_TIMEOUT_MS,
      init: {
        method: "POST",
        headers: {
          "content-type":
            headerValue(params.req.headers["content-type"]) ?? "application/x-www-form-urlencoded",
          ...(headerValue(params.req.headers["x-twilio-signature"])
            ? { "x-twilio-signature": headerValue(params.req.headers["x-twilio-signature"]) ?? "" }
            : {}),
        },
        body: params.body,
      },
    });
  } catch (err) {
    params.log?.error?.(`RCS shared webhook SMS forward failed: ${String(err)}`);
    respondTwiml(params.res, 502, "Gateway forwarding failed");
    return;
  }
  try {
    const forwarded = guarded.response;
    params.res.statusCode = forwarded.status;
    const contentType = forwarded.headers.get("content-type");
    if (contentType) {
      params.res.setHeader("content-type", contentType);
    }
    params.res.end(await forwarded.text());
  } finally {
    await guarded.release();
  }
}

export function createRcsWebhookHandler(
  params: RcsWebhookHandlerParams,
  deps: RcsWebhookHandlerDeps = {},
) {
  const ipRateLimiter = deps.ipRateLimiter ?? createInboundIpRateLimiter();
  const senderRateLimiter = deps.senderRateLimiter ?? createInboundSenderRateLimiter();
  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") {
      respondTwiml(res, 405, "Method not allowed");
      return true;
    }

    const key = rateLimitKey(req);
    const rateLimited = ipRateLimiter.isRateLimited(key);

    let form: Record<string, string>;
    try {
      form = await readTwilioWebhookForm(req);
    } catch {
      if (rateLimited) {
        return rejectRateLimitedRequest({ scope: "RCS webhook", key, log: params.log, res });
      }
      respondTwiml(res, 400, "Invalid request body");
      return true;
    }

    if (!params.account.dangerouslyDisableSignatureValidation) {
      const ok = verifyWebhookSignature({
        req,
        form,
        account: params.account,
        signatureUrl: resolveTwilioWebhookSignatureUrl({
          req,
          publicWebhookUrl: params.account.publicWebhookUrl,
        }),
      });
      if (!ok) {
        if (rateLimited) {
          return rejectRateLimitedRequest({ scope: "RCS webhook", key, log: params.log, res });
        }
        params.log?.warn?.("RCS webhook rejected invalid Twilio signature");
        respondTwiml(res, 403, "Invalid signature");
        return true;
      }
    }

    await dispatchVerifiedRcsForm({
      account: params.account,
      ingress: params.ingress,
      form,
      res,
      log: params.log,
      scope: "RCS webhook",
      rateLimited,
      rateLimitedKey: key,
      senderRateLimiter,
    });

    return true;
  };
}

export function createRcsSharedTwilioWebhookHandler(
  params: RcsSharedWebhookHandlerParams,
  deps: RcsWebhookHandlerDeps = {},
) {
  const ipRateLimiter = deps.ipRateLimiter ?? createInboundIpRateLimiter();
  const senderRateLimiter = deps.senderRateLimiter ?? createInboundSenderRateLimiter();
  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") {
      respondTwiml(res, 405, "Method not allowed");
      return true;
    }

    const key = rateLimitKey(req);
    const rateLimited = ipRateLimiter.isRateLimited(key);

    let body: string;
    let form: Record<string, string>;
    try {
      body = await readRequestBodyWithLimit(req, {
        maxBytes: SHARED_WEBHOOK_BODY_LIMIT_BYTES,
        timeoutMs: SHARED_WEBHOOK_BODY_TIMEOUT_MS,
      });
      form = parseTwilioFormBody(body);
    } catch {
      if (rateLimited) {
        return rejectRateLimitedRequest({ scope: "RCS shared webhook", key, log: params.log, res });
      }
      respondTwiml(res, 400, "Invalid request body");
      return true;
    }

    if (!params.account.dangerouslyDisableSignatureValidation) {
      const ok = verifyWebhookSignature({
        req,
        form,
        account: params.account,
        signatureUrl: resolveTwilioWebhookSignatureUrl({
          req,
          publicWebhookUrl: params.sharedPublicWebhookUrl,
        }),
      });
      if (!ok) {
        if (rateLimited) {
          return rejectRateLimitedRequest({
            scope: "RCS shared webhook",
            key,
            log: params.log,
            res,
          });
        }
        params.log?.warn?.("RCS shared webhook rejected invalid Twilio signature");
        respondTwiml(res, 403, "Invalid signature");
        return true;
      }
    }

    if (!formLooksRcs(form)) {
      if (rateLimited) {
        if (params.account.dangerouslyDisableSignatureValidation) {
          return rejectRateLimitedRequest({
            scope: "RCS shared webhook",
            key,
            log: params.log,
            res,
          });
        }
        params.log?.warn?.(
          `RCS shared webhook rate limit exceeded for ${key}; acknowledged validated callback ${form.MessageSid ?? form.SmsMessageSid ?? "unknown"} without SMS forward`,
        );
        respondTwiml(res, 200);
        return true;
      }
      await forwardSharedSmsWebhook({
        req,
        res,
        body,
        smsForwardWebhookPath: params.smsForwardWebhookPath,
        log: params.log,
      });
      return true;
    }

    await dispatchVerifiedRcsForm({
      account: params.account,
      ingress: params.ingress,
      form,
      res,
      log: params.log,
      scope: "RCS shared webhook",
      rateLimited,
      rateLimitedKey: key,
      senderRateLimiter,
    });
    return true;
  };
}

export function createRcsStatusCallbackHandler(params: RcsStatusCallbackHandlerParams) {
  const statusRateLimiter = createStatusRateLimiter();
  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") {
      respondTwiml(res, 405, "Method not allowed");
      return true;
    }

    const key = rateLimitKey(req);
    if (statusRateLimiter.isRateLimited(key)) {
      respondTwiml(res, 429, "Rate limit exceeded");
      return true;
    }

    let form: Record<string, string>;
    try {
      form = await readTwilioWebhookForm(req);
    } catch {
      respondTwiml(res, 400, "Invalid request body");
      return true;
    }

    if (!params.account.dangerouslyDisableSignatureValidation) {
      const ok = verifyWebhookSignature({
        req,
        form,
        account: params.account,
        signatureUrl: resolveTwilioWebhookSignatureUrl({
          req,
          publicWebhookUrl: resolveRcsStatusCallbackUrl(params.account.publicWebhookUrl),
        }),
      });
      if (!ok) {
        params.log?.warn?.("RCS status callback rejected invalid Twilio signature");
        respondTwiml(res, 403, "Invalid signature");
        return true;
      }
    }

    const event = buildTwilioStatusEvent(form);
    if (!event) {
      respondTwiml(res, 400, "Missing status payload");
      return true;
    }
    recordRcsStatusEvent(params.account.accountId, event);
    params.log?.info?.(
      `RCS message ${event.messageSid} status=${event.status}${event.errorCode ? ` error=${event.errorCode}` : ""}`,
    );

    respondTwiml(res, 200);
    return true;
  };
}
