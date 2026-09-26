import type { IncomingMessage, ServerResponse } from "node:http";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import {
  WEBHOOK_RATE_LIMIT_DEFAULTS,
  createAuthRateLimiter,
  createWebhookInFlightLimiter,
  getWebhookLegacyListener,
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  resolveRequestClientIp,
  requestBodyErrorToText,
} from "openclaw/plugin-sdk/webhook-ingress";
import { sendHttpRequestRejection } from "openclaw/plugin-sdk/webhook-request-guards";
import {
  canonicalizeWebhookRouteKey,
  registerPluginHttpRoute,
  registerWebhookTarget,
  resolveSingleWebhookTarget,
} from "openclaw/plugin-sdk/webhook-targets";
import { extractNextcloudTalkHeaders, verifyNextcloudTalkSignature } from "./signature.js";
import type { NextcloudTalkWebhookTarget } from "./types.js";
import { NextcloudTalkWebhookPayloadError } from "./webhook-spool-state.js";

const PREAUTH_WEBHOOK_MAX_BODY_BYTES = 64 * 1024;
const NEXTCLOUD_TALK_WEBHOOK_ACCEPTED_HEADER = "x-openclaw-delivery-accepted";
const NEXTCLOUD_TALK_WEBHOOK_ACCEPTED_VALUE = "durable";
const PREAUTH_WEBHOOK_BODY_TIMEOUT_MS = 5_000;
// Bound concurrent unauthenticated body reads. Incomplete requests would otherwise
// occupy readers and sockets for the full pre-auth timeout without ever consuming
// the authentication-failure budget.
const PREAUTH_WEBHOOK_MAX_IN_FLIGHT = 64;
const WEBHOOK_IN_FLIGHT_KEY = "nextcloud-talk-webhook";
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

type RegisteredNextcloudTalkWebhookTarget = NextcloudTalkWebhookTarget & {
  rawPath: string;
  stopping: boolean;
  pendingResponses: Set<Promise<void>>;
};

function createWebhookGuards() {
  return {
    authRateLimiter: createAuthRateLimiter({
      maxAttempts: WEBHOOK_RATE_LIMIT_DEFAULTS.maxRequests,
      windowMs: WEBHOOK_RATE_LIMIT_DEFAULTS.windowMs,
      lockoutMs: WEBHOOK_RATE_LIMIT_DEFAULTS.windowMs,
      exemptLoopback: false,
      pruneIntervalMs: WEBHOOK_RATE_LIMIT_DEFAULTS.windowMs,
    }),
    inFlightLimiter: createWebhookInFlightLimiter({
      maxInFlightPerKey: PREAUTH_WEBHOOK_MAX_IN_FLIGHT,
      maxTrackedKeys: 1,
    }),
  };
}

function legacyListenerKey(listener: NonNullable<NextcloudTalkWebhookTarget["legacyListener"]>) {
  return JSON.stringify([listener.port, listener.host]);
}

function createWebhookHandler(
  getTargets: () => readonly RegisteredNextcloudTalkWebhookTarget[],
  legacyGuards: ReadonlyMap<string, ReturnType<typeof createWebhookGuards>>,
) {
  const gatewayGuards = createWebhookGuards();

  const handleWebhookRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const legacyListener = getWebhookLegacyListener(req);
    const requestTargets = getTargets().filter(
      (entry) =>
        entry.rawPath === req.url &&
        (!legacyListener ||
          (entry.legacyListener?.port === legacyListener.port &&
            entry.legacyListener.host === legacyListener.host)),
    );
    if (req.method !== "POST" || requestTargets.length === 0) {
      res.writeHead(404);
      res.end();
      return;
    }
    const servingTargets = requestTargets.filter((entry) => !entry.stopping);
    const firstTarget = servingTargets[0];
    if (!firstTarget) {
      res.writeHead(503, { "Retry-After": "1" });
      res.end();
      return;
    }
    const responseOwners = new Map<RegisteredNextcloudTalkWebhookTarget, () => void>();
    // Authentication selects the account after upload; until then each candidate owns the read.
    if (!res.destroyed && !res.writableFinished) {
      for (const entry of servingTargets) {
        const responseDone = Promise.withResolvers<void>();
        entry.pendingResponses.add(responseDone.promise);
        responseOwners.set(entry, () => {
          entry.pendingResponses.delete(responseDone.promise);
          responseOwners.delete(entry);
          responseDone.resolve();
        });
      }
      const complete = () => {
        res.off("finish", complete);
        res.off("close", complete);
        for (const release of responseOwners.values()) {
          release();
        }
      };
      res.once("finish", complete);
      res.once("close", complete);
    }
    const guards = legacyListener
      ? legacyGuards.get(legacyListenerKey(legacyListener))
      : gatewayGuards;
    if (!guards) {
      res.writeHead(503, { "Retry-After": "1" });
      res.end();
      return;
    }
    const { authRateLimiter: webhookAuthRateLimiter, inFlightLimiter: webhookInFlightLimiter } =
      guards;
    const { onError, trustedProxies, allowRealIpFallback } = firstTarget;
    const clientIp =
      resolveRequestClientIp(req, trustedProxies, allowRealIpFallback) ??
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
    let target: RegisteredNextcloudTalkWebhookTarget;
    try {
      const headers = extractNextcloudTalkHeaders(req.headers);
      if (!headers) {
        writeWebhookError(res, 400, WEBHOOK_ERRORS.missingSignatureHeaders);
        return;
      }
      const targets = requestTargets.filter(
        (entry) => !entry.isBackendAllowed || entry.isBackendAllowed(headers.backend),
      );
      if (targets.length === 0) {
        writeWebhookError(res, 401, WEBHOOK_ERRORS.invalidBackend);
        return;
      }
      body = await readRequestBodyWithLimit(req, {
        maxBytes: PREAUTH_WEBHOOK_MAX_BODY_BYTES,
        timeoutMs: PREAUTH_WEBHOOK_BODY_TIMEOUT_MS,
        // Send the rejection before closing an incomplete upload.
        destroyOnLimit: false,
      });
      const match = resolveSingleWebhookTarget(targets, (entry) =>
        verifyNextcloudTalkSignature({ ...headers, body, secret: entry.secret }),
      );
      if (match.kind !== "single") {
        webhookAuthRateLimiter.recordFailure(clientIp, WEBHOOK_AUTH_RATE_LIMIT_SCOPE);
        writeWebhookError(res, 401, WEBHOOK_ERRORS.invalidSignature);
        return;
      }
      target = match.target;
      for (const [entry, release] of responseOwners) {
        if (entry !== target) {
          release();
        }
      }
      // A stopping account's valid signature remains retryable without charging siblings' quota.
      if (!servingTargets.includes(target) || !getTargets().includes(target)) {
        res.writeHead(503, { "Retry-After": "1" });
        res.end();
        return;
      }
      webhookAuthRateLimiter.reset(clientIp, WEBHOOK_AUTH_RATE_LIMIT_SCOPE);
    } catch (err) {
      if (isRequestBodyLimitError(err, "PAYLOAD_TOO_LARGE")) {
        await rejectWebhookRequest(req, res, 413, WEBHOOK_ERRORS.payloadTooLarge);
        return;
      }
      if (isRequestBodyLimitError(err, "REQUEST_BODY_TIMEOUT")) {
        await rejectWebhookRequest(req, res, 408, requestBodyErrorToText("REQUEST_BODY_TIMEOUT"));
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
      const admission = await target.onWebhook(body);
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
        // Malformed envelopes are client errors, unlike failed durable admission.
        writeWebhookError(res, 400, WEBHOOK_ERRORS.invalidPayloadFormat);
        return;
      }
      const error = err instanceof Error ? err : new Error(formatErrorMessage(err));
      target.onError?.(error);
      writeWebhookError(res, 500, WEBHOOK_ERRORS.internalServerError);
    }
  };

  return {
    handler: handleWebhookRequest,
    dispose: () => gatewayGuards.authRateLimiter.dispose(),
  };
}

const webhookState = createPluginRuntimeStore<{
  targets: Map<string, RegisteredNextcloudTalkWebhookTarget[]>;
  handlers: Map<string, ReturnType<typeof createWebhookHandler>>;
  legacyGuards: Map<string, ReturnType<typeof createWebhookGuards>>;
}>({
  key: "nextcloud-talk:webhook-routes",
  errorMessage: "Nextcloud Talk webhook routes are not registered",
});

export function registerNextcloudTalkWebhook(
  target: NextcloudTalkWebhookTarget,
): () => Promise<void> {
  let state = webhookState.tryGetRuntime();
  if (!state) {
    state = { targets: new Map(), handlers: new Map(), legacyGuards: new Map() };
    webhookState.setRuntime(state);
  }
  const { targets, handlers, legacyGuards } = state;
  const syncLegacyGuards = () => {
    const endpoints = new Set<string>();
    for (const routeTargets of targets.values()) {
      for (const { legacyListener } of routeTargets) {
        if (!legacyListener) {
          continue;
        }
        const key = legacyListenerKey(legacyListener);
        endpoints.add(key);
        if (!legacyGuards.has(key)) {
          legacyGuards.set(key, createWebhookGuards());
        }
      }
    }
    for (const [key, guards] of legacyGuards) {
      if (!endpoints.has(key)) {
        guards.authRateLimiter.dispose();
        legacyGuards.delete(key);
      }
    }
  };
  const path = canonicalizeWebhookRouteKey(target.path);
  const registration = registerWebhookTarget(targets, {
    ...target,
    path,
    rawPath: target.path,
    stopping: false,
    pendingResponses: new Set<Promise<void>>(),
  });
  let handler = handlers.get(path);
  if (!handler) {
    handler = createWebhookHandler(() => targets.get(path) ?? [], legacyGuards);
    handlers.set(path, handler);
  }
  syncLegacyGuards();
  const removeTarget = () => {
    registration.unregister();
    if (!targets.has(path)) {
      handlers.get(path)?.dispose();
      handlers.delete(path);
    }
    syncLegacyGuards();
  };
  try {
    const unregister = registerPluginHttpRoute({
      path,
      auth: "plugin",
      pluginId: "nextcloud-talk",
      source: "webhook",
      accountId: target.accountId,
      handler: handler.handler,
      legacyListener: target.legacyListener
        ? { ...target.legacyListener, health: { path: "/healthz", contentType: "text/plain" } }
        : undefined,
      reuseExistingSameOwner: true,
      throwOnFailure: true,
    });
    let stopPromise: Promise<void> | undefined;
    return () => {
      if (stopPromise) {
        return stopPromise;
      }
      registration.target.stopping = true;
      const release = () => {
        removeTarget();
        unregister();
      };
      const pending = registration.target.pendingResponses;
      if (pending.size === 0) {
        release();
        stopPromise = Promise.resolve();
      } else {
        stopPromise = Promise.all(pending).then(release);
      }
      return stopPromise;
    };
  } catch (error) {
    removeTarget();
    throw error;
  }
}
