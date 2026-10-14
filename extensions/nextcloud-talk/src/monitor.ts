import type { IncomingMessage, ServerResponse } from "node:http";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
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
function writeWebhookError(res: ServerResponse, status: number, error: string): void {
  if (res.headersSent) {
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error }));
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
  gatewayGuards: ReturnType<typeof createWebhookGuards>;
  legacyGuards?: ReturnType<typeof createWebhookGuards>;
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

async function handleWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
  targetsByPath: Map<string, RegisteredNextcloudTalkWebhookTarget[]>,
  path: string,
): Promise<void> {
  const legacyListener = getWebhookLegacyListener(req);
  const requestTargets = (targetsByPath.get(path) ?? []).filter(
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
      const responseDone = createDeferred<void>();
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
  const guards = legacyListener ? firstTarget.legacyGuards : firstTarget.gatewayGuards;
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
      writeWebhookError(res, 400, "Missing signature headers");
      return;
    }
    const targets = requestTargets.filter(
      (entry) => !entry.isBackendAllowed || entry.isBackendAllowed(headers.backend),
    );
    if (targets.length === 0) {
      writeWebhookError(res, 401, "Invalid backend");
      return;
    }
    body = await readRequestBodyWithLimit(req, {
      maxBytes: PREAUTH_WEBHOOK_MAX_BODY_BYTES,
      timeoutMs: PREAUTH_WEBHOOK_BODY_TIMEOUT_MS,
      // Send the rejection before closing an incomplete upload.
      destroyOnLimit: false,
    });
    const matchesSignature = (entry: RegisteredNextcloudTalkWebhookTarget) =>
      verifyNextcloudTalkSignature({ ...headers, body, secret: entry.secret });
    const match = resolveSingleWebhookTarget(
      targets,
      (entry) => servingTargets.includes(entry) && matchesSignature(entry),
    );
    if (
      match.kind === "none" &&
      targets.some((entry) => !servingTargets.includes(entry) && matchesSignature(entry))
    ) {
      res.writeHead(503, { "Retry-After": "1" });
      res.end();
      return;
    }
    if (match.kind !== "single") {
      webhookAuthRateLimiter.recordFailure(clientIp, WEBHOOK_AUTH_RATE_LIMIT_SCOPE);
      writeWebhookError(res, 401, "Invalid signature");
      return;
    }
    target = match.target;
    for (const [entry, release] of responseOwners) {
      if (entry !== target) {
        release();
      }
    }
    if (!targetsByPath.get(path)?.includes(target)) {
      res.writeHead(503, { "Retry-After": "1" });
      res.end();
      return;
    }
    webhookAuthRateLimiter.reset(clientIp, WEBHOOK_AUTH_RATE_LIMIT_SCOPE);
  } catch (err) {
    if (isRequestBodyLimitError(err, "PAYLOAD_TOO_LARGE")) {
      await rejectWebhookRequest(req, res, 413, "Payload too large");
      return;
    }
    if (isRequestBodyLimitError(err, "REQUEST_BODY_TIMEOUT")) {
      await rejectWebhookRequest(req, res, 408, requestBodyErrorToText("REQUEST_BODY_TIMEOUT"));
      return;
    }
    const error = err instanceof Error ? err : new Error(formatErrorMessage(err));
    onError?.(error);
    writeWebhookError(res, 500, "Internal server error");
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
      res.setHeader(NEXTCLOUD_TALK_WEBHOOK_ACCEPTED_HEADER, NEXTCLOUD_TALK_WEBHOOK_ACCEPTED_VALUE);
    }
    res.writeHead(200);
    res.end();
  } catch (err) {
    if (err instanceof NextcloudTalkWebhookPayloadError) {
      // Malformed envelopes are client errors, unlike failed durable admission.
      writeWebhookError(res, 400, "Invalid payload format");
      return;
    }
    const error = err instanceof Error ? err : new Error(formatErrorMessage(err));
    target.onError?.(error);
    writeWebhookError(res, 500, "Internal server error");
  }
}

const webhookState = createPluginRuntimeStore<Map<string, RegisteredNextcloudTalkWebhookTarget[]>>({
  key: "nextcloud-talk:webhook-routes",
  errorMessage: "Nextcloud Talk webhook routes are not registered",
});

export function registerNextcloudTalkWebhook(
  target: NextcloudTalkWebhookTarget,
): () => Promise<void> {
  let targets = webhookState.tryGetRuntime();
  if (!targets) {
    targets = new Map();
    webhookState.setRuntime(targets);
  }
  const path = canonicalizeWebhookRouteKey(target.path);
  // The live targets own limiter sharing: Gateway budgets belong to a path,
  // while a compatibility port shares one budget across all of its paths.
  const gatewayGuards = targets.get(path)?.[0]?.gatewayGuards ?? createWebhookGuards();
  const endpoint = target.legacyListener;
  const legacyGuards = endpoint
    ? ([...targets.values()]
        .flat()
        .find(
          (entry) =>
            entry.legacyListener?.port === endpoint.port &&
            entry.legacyListener.host === endpoint.host,
        )?.legacyGuards ?? createWebhookGuards())
    : undefined;
  const registration = registerWebhookTarget(targets, {
    ...target,
    path,
    rawPath: target.path,
    stopping: false,
    pendingResponses: new Set<Promise<void>>(),
    gatewayGuards,
    legacyGuards,
  });
  const removeTarget = () => {
    registration.unregister();
    const remaining = [...targets.values()].flat();
    for (const guards of [gatewayGuards, legacyGuards]) {
      if (
        guards &&
        !remaining.some((entry) => entry.gatewayGuards === guards || entry.legacyGuards === guards)
      ) {
        guards.authRateLimiter.dispose();
      }
    }
  };
  try {
    const unregister = registerPluginHttpRoute({
      path,
      auth: "plugin",
      pluginId: "nextcloud-talk",
      source: "webhook",
      accountId: target.accountId,
      handler: (req, res) => handleWebhookRequest(req, res, targets, path),
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
