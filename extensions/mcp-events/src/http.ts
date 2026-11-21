import type { IncomingHttpHeaders } from "node:http";
import { sendJsonWithoutCharset } from "openclaw/plugin-sdk/http-response-runtime";
import type { OpenClawPluginHttpRouteHandler } from "openclaw/plugin-sdk/plugin-entry";
import {
  createWebhookInFlightLimiter,
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  sendHttpRequestRejection,
} from "openclaw/plugin-sdk/webhook-request-guards";
import {
  CALLBACK_PREFIX,
  CallbackError,
  MAX_EVENT_BYTES,
  MCP_EVENTS_PROFILE,
  identityHash,
  parseCallback,
  verifyWebhook,
} from "./protocol.js";
import type { McpEventsService } from "./service.js";
import { isAuthorityUnavailable } from "./source-authority.js";

export function createCallbackHandler(
  getService: () => McpEventsService | undefined,
): OpenClawPluginHttpRouteHandler {
  const limiter = createWebhookInFlightLimiter({ maxInFlightPerKey: 32, maxTrackedKeys: 1 });
  return async (req, res) => {
    const pathname = new URL(req.url ?? "/", "http://callback.invalid").pathname;
    if (!pathname.startsWith(CALLBACK_PREFIX)) {
      return false;
    }
    const id = pathname.slice(CALLBACK_PREFIX.length);
    if (!/^[a-f0-9-]{36}$/u.test(id)) {
      await sendHttpRequestRejection(req, res, 404, "Unknown callback");
      return true;
    }
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      await sendHttpRequestRejection(req, res, 405, "POST required");
      return true;
    }
    if (
      !/^application\/json(?:\s*;|$)/iu.test(req.headers["content-type"] ?? "") ||
      (req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity")
    ) {
      await sendHttpRequestRejection(req, res, 415, "Uncompressed application/json required");
      return true;
    }
    const service = getService();
    if (!service || !limiter.tryAcquire("callbacks")) {
      res.setHeader("Retry-After", "5");
      await sendHttpRequestRejection(req, res, 503, "Callback unavailable; retry later");
      return true;
    }
    try {
      // Preserve invalid UTF-8: replacement decoding must not change the authenticated bytes.
      const raw = await readRequestBodyWithLimit(req, {
        maxBytes: MAX_EVENT_BYTES,
        timeoutMs: 5_000,
        encoding: "base64",
        destroyOnLimit: false,
      });
      const result = await receiveCallback(service, id, req.headers, Buffer.from(raw, "base64"));
      res.setHeader("Cache-Control", "no-store");
      sendJsonWithoutCharset(res, 200, result);
    } catch (error) {
      const status =
        error instanceof CallbackError
          ? error.status
          : isRequestBodyLimitError(error)
            ? error.statusCode
            : 503;
      if (status === 503) {
        res.setHeader("Retry-After", "5");
      }
      await sendHttpRequestRejection(
        req,
        res,
        status,
        error instanceof CallbackError
          ? error.message
          : status === 413
            ? "Event exceeds 256 KiB"
            : "Callback unavailable; retry later",
      );
    } finally {
      limiter.release("callbacks");
    }
    return true;
  };
}

/** Called only after bounded raw-body admission by the registered HTTP route. */
async function receiveCallback(
  service: McpEventsService,
  bindingId: string,
  headers: IncomingHttpHeaders,
  body: Buffer,
): Promise<{ challenge?: string }> {
  if (service.initialization !== "ready") {
    throw new CallbackError(503, "Subscription state is loading; retry later");
  }
  service.assertService();
  const binding = service.bindings.get(bindingId);
  if (!binding?.live) {
    throw new CallbackError(410, "Subscription is no longer active");
  }
  try {
    await service.authority.refresh(binding);
  } catch (error) {
    if (isAuthorityUnavailable(error)) {
      throw new CallbackError(503, "Subscription authority is temporarily unavailable");
    }
    await service.revoke(binding, "source_unavailable");
    throw new CallbackError(410, "Subscription source is no longer authorized");
  }
  const guard = service.authority.guard(binding);
  guard();
  const secrets = [
    binding.facts.secret,
    ...(binding.facts.pendingSecret ? [binding.facts.pendingSecret] : []),
    ...(binding.facts.previousSecret && binding.facts.previousSecret.until > service.now
      ? [binding.facts.previousSecret.value]
      : []),
  ];
  const webhookId = verifyWebhook({ headers, body, secrets, now: service.now });
  const parsed = parseCallback(body, webhookId, binding.facts.definition);
  if (parsed.kind === "verification") {
    guard();
    return { challenge: parsed.challenge };
  }
  if (binding.facts.status !== "active") {
    throw new CallbackError(503, "Subscription activation is pending");
  }
  if (!binding.facts.refreshBefore || binding.facts.refreshBefore <= service.now) {
    if (binding.pending || binding.facts.pendingSecret) {
      throw new CallbackError(503, "Subscription renewal is pending");
    }
    throw new CallbackError(410, "Subscription expired");
  }
  const account = service.account(binding.facts.accountId);
  const admission = account.admission.then(async () => {
    guard();
    const id = identityHash([binding.facts.accountId, bindingId, parsed.event.eventId]);
    const unsettled = await account.queue.listUnsettled!();
    guard();
    const duplicate =
      unsettled.pending.some((row) => row.id === id) ||
      unsettled.claims.some((row) => row.id === id);
    if (
      !duplicate &&
      unsettled.pending.length + unsettled.claims.length >= service.deps.config.maxPendingEvents
    ) {
      throw new CallbackError(503, "Event queue is full; retry later");
    }
    const result = await account.queue.enqueueAuthorized!(
      id,
      {
        jobId: binding.facts.jobId,
        sourceIdentity: binding.facts.sourceIdentity,
        eventId: parsed.event.eventId,
        receivedAtMs: service.now,
        payload: { profile: MCP_EVENTS_PROFILE, bindingId, event: parsed.event },
      },
      { laneKey: binding.facts.jobId, receivedAt: service.now, assertCurrent: guard },
    );
    guard();
    if (result.kind === "failed") {
      throw new CallbackError(503, "Event is retained for recovery; inspect ingress diagnostics");
    }
    // Persist only after durable ingress. Cursors are opaque upstream watermarks, not event sequence IDs.
    if (result.kind === "accepted" || result.kind === "pending" || result.kind === "claimed") {
      const cursor = result.record.payload.payload.event.cursor;
      await service.mutate(binding, (facts) => {
        facts.cursor = cursor;
        facts.cursorRevision++;
      });
    }
    guard();
  });
  account.admission = admission.catch(() => {});
  try {
    await service.track(admission);
  } finally {
    // A cursor write can fail after durable enqueue; committed work must still be woken.
    service.requestDrain();
  }
  return {};
}
