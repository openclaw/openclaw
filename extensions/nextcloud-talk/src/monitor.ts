// Nextcloud Talk plugin module implements monitor behavior.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  WEBHOOK_RATE_LIMIT_DEFAULTS,
  createAuthRateLimiter,
  createWebhookInFlightLimiter,
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  resolveRequestClientIp,
  requestBodyErrorToText,
} from "openclaw/plugin-sdk/webhook-ingress";
import {
  runHttpConnectionRequest,
  sendHttpRequestRejection,
} from "openclaw/plugin-sdk/webhook-request-guards";
import { extractNextcloudTalkHeaders, verifyNextcloudTalkSignature } from "./signature.js";
import type { NextcloudTalkWebhookHeaders, NextcloudTalkWebhookServerOptions } from "./types.js";
import { NextcloudTalkWebhookPayloadError } from "./webhook-spool-state.js";

const DEFAULT_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
const PREAUTH_WEBHOOK_MAX_BODY_BYTES = 64 * 1024;
const NEXTCLOUD_TALK_WEBHOOK_ACCEPTED_HEADER = "x-openclaw-delivery-accepted";
const NEXTCLOUD_TALK_WEBHOOK_ACCEPTED_VALUE = "durable";
const PREAUTH_WEBHOOK_BODY_TIMEOUT_MS = 5_000;
// Bound concurrent unauthenticated body reads. Incomplete requests would otherwise
// occupy readers and sockets for the full pre-auth timeout without ever consuming
// the authentication-failure budget.
const PREAUTH_WEBHOOK_MAX_IN_FLIGHT = 64;
const WEBHOOK_IN_FLIGHT_KEY = "nextcloud-talk-webhook";
const HEALTH_PATH = "/healthz";
const WEBHOOK_AUTH_RATE_LIMIT_SCOPE = "nextcloud-talk-webhook-auth";
const WEBHOOK_ERRORS = {
  missingSignatureHeaders: "Missing signature headers",
  invalidBackend: "Invalid backend",
  invalidSignature: "Invalid signature",
  invalidPayloadFormat: "Invalid payload format",
  payloadTooLarge: "Payload too large",
  internalServerError: "Internal server error",
} as const;

function writeJsonResponse(
  res: ServerResponse,
  status: number,
  body?: Record<string, unknown>,
): void {
  if (body) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
    return;
  }
  res.writeHead(status);
  res.end();
}

function writeWebhookError(res: ServerResponse, status: number, error: string): void {
  if (res.headersSent) {
    return;
  }
  writeJsonResponse(res, status, { error });
}

function validateWebhookHeaders(params: {
  req: IncomingMessage;
  res: ServerResponse;
  isBackendAllowed?: (backend: string) => boolean;
}): NextcloudTalkWebhookHeaders | null {
  const headers = extractNextcloudTalkHeaders(
    params.req.headers as Record<string, string | string[] | undefined>,
  );
  if (!headers) {
    writeWebhookError(params.res, 400, WEBHOOK_ERRORS.missingSignatureHeaders);
    return null;
  }
  if (params.isBackendAllowed && !params.isBackendAllowed(headers.backend)) {
    writeWebhookError(params.res, 401, WEBHOOK_ERRORS.invalidBackend);
    return null;
  }
  return headers;
}

function verifyWebhookSignature(params: {
  headers: NextcloudTalkWebhookHeaders;
  body: string;
  secret: string;
  res: ServerResponse;
  clientIp: string;
  authRateLimiter: ReturnType<typeof createAuthRateLimiter>;
}): boolean {
  const isValid = verifyNextcloudTalkSignature({
    signature: params.headers.signature,
    random: params.headers.random,
    body: params.body,
    secret: params.secret,
  });
  if (!isValid) {
    params.authRateLimiter.recordFailure(params.clientIp, WEBHOOK_AUTH_RATE_LIMIT_SCOPE);
    writeWebhookError(params.res, 401, WEBHOOK_ERRORS.invalidSignature);
    return false;
  }
  params.authRateLimiter.reset(params.clientIp, WEBHOOK_AUTH_RATE_LIMIT_SCOPE);
  return true;
}

function readNextcloudTalkWebhookBody(req: IncomingMessage, maxBodyBytes: number): Promise<string> {
  return readRequestBodyWithLimit(req, {
    // This read happens before signature verification, so keep the unauthenticated
    // body budget bounded even if the operator-configured post-parse limit is larger.
    maxBytes: Math.min(maxBodyBytes, PREAUTH_WEBHOOK_MAX_BODY_BYTES),
    timeoutMs: PREAUTH_WEBHOOK_BODY_TIMEOUT_MS,
    // Defer destruction so the rejections below reach the backend before the close.
    destroyOnLimit: false,
  });
}

async function rejectWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  error: string,
): Promise<void> {
  if (res.headersSent) {
    return;
  }
  await sendHttpRequestRejection(req, res, status, JSON.stringify({ error }), "application/json");
}

export function createNextcloudTalkWebhookServer(opts: NextcloudTalkWebhookServerOptions): {
  server: Server;
  start: () => Promise<void>;
  stop: () => Promise<void>;
} {
  const { port, host, path, secret, onWebhook, onError, abortSignal } = opts;
  const maxBodyBytes =
    typeof opts.maxBodyBytes === "number" &&
    Number.isFinite(opts.maxBodyBytes) &&
    opts.maxBodyBytes > 0
      ? Math.floor(opts.maxBodyBytes)
      : DEFAULT_WEBHOOK_MAX_BODY_BYTES;
  const readBody = opts.readBody ?? readNextcloudTalkWebhookBody;
  const isBackendAllowed = opts.isBackendAllowed;
  const authRateLimitMaxRequests =
    typeof opts.authRateLimit?.maxRequests === "number"
      ? opts.authRateLimit.maxRequests
      : WEBHOOK_RATE_LIMIT_DEFAULTS.maxRequests;
  const authRateLimitWindowMs =
    typeof opts.authRateLimit?.windowMs === "number"
      ? opts.authRateLimit.windowMs
      : WEBHOOK_RATE_LIMIT_DEFAULTS.windowMs;
  const webhookAuthRateLimiter = createAuthRateLimiter({
    maxAttempts: authRateLimitMaxRequests,
    windowMs: authRateLimitWindowMs,
    lockoutMs: authRateLimitWindowMs,
    exemptLoopback: false,
    pruneIntervalMs: authRateLimitWindowMs,
  });
  const webhookInFlightLimiter = createWebhookInFlightLimiter({
    maxInFlightPerKey: PREAUTH_WEBHOOK_MAX_IN_FLIGHT,
    maxTrackedKeys: 1,
  });

  const handleWebhookRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.url === HEALTH_PATH) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }

    if (req.url !== path || req.method !== "POST") {
      res.writeHead(404);
      res.end();
      return;
    }

    const clientIp =
      resolveRequestClientIp(req, opts.trustedProxies, opts.allowRealIpFallback) ??
      req.socket.remoteAddress ??
      "unknown";
    if (!webhookAuthRateLimiter.check(clientIp, WEBHOOK_AUTH_RATE_LIMIT_SCOPE).allowed) {
      res.writeHead(429);
      res.end("Too Many Requests");
      return;
    }

    // Acquire before the unauthenticated read so overflow requests are rejected
    // immediately instead of pinning a reader for the full pre-auth timeout.
    if (!webhookInFlightLimiter.tryAcquire(WEBHOOK_IN_FLIGHT_KEY)) {
      // Close-aware rejection frees the socket instead of leaving it half-open.
      await sendHttpRequestRejection(req, res, 429, "Too Many Requests");
      return;
    }

    let body: string;
    try {
      const headers = validateWebhookHeaders({
        req,
        res,
        isBackendAllowed,
      });
      if (!headers) {
        return;
      }

      body = await readBody(req, maxBodyBytes);

      const hasValidSignature = verifyWebhookSignature({
        headers,
        body,
        secret,
        res,
        clientIp,
        authRateLimiter: webhookAuthRateLimiter,
      });
      if (!hasValidSignature) {
        return;
      }
    } catch (err) {
      if (isRequestBodyLimitError(err, "PAYLOAD_TOO_LARGE")) {
        await rejectWebhookRequest(req, res, 413, WEBHOOK_ERRORS.payloadTooLarge);
        return;
      }
      if (isRequestBodyLimitError(err, "REQUEST_BODY_TIMEOUT")) {
        await rejectWebhookRequest(req, res, 408, requestBodyErrorToText("REQUEST_BODY_TIMEOUT"));
        return;
      }
      if (err instanceof NextcloudTalkWebhookPayloadError) {
        writeWebhookError(res, 400, WEBHOOK_ERRORS.invalidPayloadFormat);
        return;
      }
      const error = err instanceof Error ? err : new Error(formatErrorMessage(err));
      onError?.(error);
      writeWebhookError(res, 500, WEBHOOK_ERRORS.internalServerError);
      return;
    } finally {
      // Release before authenticated dispatch so a slow handler cannot exhaust
      // the pre-auth admission budget for other deliveries.
      webhookInFlightLimiter.release(WEBHOOK_IN_FLIGHT_KEY);
    }

    try {
      // Nextcloud retries only a few times. Acknowledge only after the raw
      // envelope is durably admitted; append failure must remain retryable.
      const admission = await onWebhook(body);
      if (admission === "accepted") {
        // Ignored non-message events still receive 200 but must not claim
        // durable adoption.
        res.setHeader(
          NEXTCLOUD_TALK_WEBHOOK_ACCEPTED_HEADER,
          NEXTCLOUD_TALK_WEBHOOK_ACCEPTED_VALUE,
        );
      }
      writeJsonResponse(res, 200);
    } catch (err) {
      if (err instanceof NextcloudTalkWebhookPayloadError) {
        // Admission-stage envelope validation maps to the same 400 as read-stage
        // payload failures; it is a permanent client error, not a server fault.
        writeWebhookError(res, 400, WEBHOOK_ERRORS.invalidPayloadFormat);
        return;
      }
      const error = err instanceof Error ? err : new Error(formatErrorMessage(err));
      onError?.(error);
      writeWebhookError(res, 500, WEBHOOK_ERRORS.internalServerError);
    }
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Per-connection ordering: a pipelined request must not reach the overflow
    // rejection until every earlier response on this connection finished, or the
    // rejection's close timer could destroy an unflushed acknowledgement.
    void runHttpConnectionRequest(req, () => handleWebhookRequest(req, res), res).catch(
      (error: unknown) => {
        onError?.(error instanceof Error ? error : new Error(formatErrorMessage(error)));
        if (!res.destroyed && typeof res.destroy === "function") {
          res.destroy();
        }
      },
    );
  });

  let stopRequested = false;
  // The listen callback, rather than server.listening, owns the point where a
  // startup-racing stop can safely close without cancelling that callback.
  let listenerActive = false;
  let closePromise: Promise<void> | undefined;
  const closeIfListening = (): Promise<void> => {
    if (closePromise) {
      return closePromise;
    }
    if (!listenerActive) {
      return Promise.resolve();
    }
    closePromise = new Promise<void>((resolve) => {
      server.close(() => resolve());
    }).finally(() => {
      listenerActive = false;
      closePromise = undefined;
    });
    return closePromise;
  };
  const stop = async () => {
    stopRequested = true;
    await closeIfListening();
    webhookAuthRateLimiter.dispose();
  };

  const start = (): Promise<void> => {
    if (stopRequested) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const onListenError = (error: Error) => reject(error);
      server.once("error", onListenError);
      server.listen(port, host, () => {
        listenerActive = true;
        server.off("error", onListenError);
        void (async () => {
          // Abort can land between listen() and its callback. Close after the
          // listener becomes visible so a stopped monitor never retains the port.
          if (stopRequested) {
            await closeIfListening();
          }
          resolve();
        })().catch(reject);
      });
    });
  };

  if (abortSignal) {
    if (abortSignal.aborted) {
      void stop();
    } else {
      abortSignal.addEventListener("abort", () => void stop(), { once: true });
    }
  }

  return { server, start, stop };
}
