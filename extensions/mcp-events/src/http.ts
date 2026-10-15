import type { OpenClawPluginHttpRouteHandler } from "openclaw/plugin-sdk/plugin-entry";
import {
  createWebhookInFlightLimiter,
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  sendHttpRequestRejection,
} from "openclaw/plugin-sdk/webhook-request-guards";
import { CALLBACK_PREFIX, CallbackError, MAX_EVENT_BYTES } from "./protocol.js";
import type { McpEventsService } from "./service.js";

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
      const result = await service.receive(id, req.headers, Buffer.from(raw, "base64"));
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      res.end(JSON.stringify(result));
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
