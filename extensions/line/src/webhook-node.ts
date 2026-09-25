import type { IncomingMessage, ServerResponse } from "node:http";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { danger, logVerbose, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { resolveSingleWebhookTarget } from "openclaw/plugin-sdk/webhook-ingress";
import {
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
  sendHttpRequestRejection,
} from "openclaw/plugin-sdk/webhook-request-guards";
import type { createLineBot } from "./bot.js";
import { parseLineWebhookBody, validateLineSignature } from "./webhook-utils.js";

const LINE_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
const LINE_WEBHOOK_PREAUTH_MAX_BODY_BYTES = 64 * 1024;
const LINE_WEBHOOK_PREAUTH_BODY_TIMEOUT_MS = 5_000;

export async function readLineWebhookRequestBody(
  req: IncomingMessage,
  maxBytes = LINE_WEBHOOK_MAX_BODY_BYTES,
  timeoutMs = LINE_WEBHOOK_PREAUTH_BODY_TIMEOUT_MS,
): Promise<string> {
  return await readRequestBodyWithLimit(req, {
    maxBytes,
    timeoutMs,
    // Defer destruction so the caller can answer 413/408 before the connection closes.
    destroyOnLimit: false,
  });
}

type ReadBodyFn = (req: IncomingMessage, maxBytes: number, timeoutMs?: number) => Promise<string>;

/**
 * Answer a body-limit failure through the connection owner.
 *
 * The reader defers destruction for these two codes, so the connection is already fenced
 * and only the owner can still write: responding directly would race the teardown and LINE
 * would see a reset instead of the status.
 */
async function rejectLineWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
  error: unknown,
): Promise<boolean> {
  if (
    !isRequestBodyLimitError(error, "PAYLOAD_TOO_LARGE") &&
    !isRequestBodyLimitError(error, "REQUEST_BODY_TIMEOUT")
  ) {
    return false;
  }
  await sendHttpRequestRejection(
    req,
    res,
    error.statusCode,
    JSON.stringify({ error: requestBodyErrorToText(error.code) }),
    "application/json",
  );
  return true;
}

type LineWebhookTarget = {
  channelSecret: string;
  bot: Pick<ReturnType<typeof createLineBot>, "handleWebhook">;
};

export function createLineNodeWebhookHandler(params: {
  getTargets: () => readonly LineWebhookTarget[];
  runtime: RuntimeEnv;
  readBody?: ReadBodyFn;
  maxBodyBytes?: number;
}): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const maxBodyBytes = params.maxBodyBytes ?? LINE_WEBHOOK_MAX_BODY_BYTES;
  const readBody = params.readBody ?? readLineWebhookRequestBody;

  return async (req: IncomingMessage, res: ServerResponse) => {
    const targets = params.getTargets();
    if (req.method !== "POST" && targets.length === 0) {
      res.statusCode = 404;
      res.end("Not Found");
      return;
    }
    if (req.method === "GET" || req.method === "HEAD") {
      if (req.method === "HEAD") {
        res.statusCode = 204;
        res.end();
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain");
      res.end("OK");
      return;
    }

    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "GET, HEAD, POST");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Method Not Allowed" }));
      return;
    }

    try {
      const signatureHeader = req.headers["x-line-signature"];
      const signature =
        typeof signatureHeader === "string"
          ? signatureHeader.trim()
          : Array.isArray(signatureHeader)
            ? (signatureHeader[0] ?? "").trim()
            : "";

      if (!signature) {
        logVerbose("line: webhook missing X-Line-Signature header");
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Missing X-Line-Signature header" }));
        return;
      }

      const rawBody = await readBody(
        req,
        Math.min(maxBodyBytes, LINE_WEBHOOK_PREAUTH_MAX_BODY_BYTES),
        LINE_WEBHOOK_PREAUTH_BODY_TIMEOUT_MS,
      );

      const match = resolveSingleWebhookTarget(targets, (target) =>
        validateLineSignature(rawBody, signature, target.channelSecret),
      );
      if (match.kind === "none") {
        logVerbose("line: webhook signature validation failed");
        res.statusCode = 401;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Invalid signature" }));
        return;
      }

      if (match.kind === "ambiguous") {
        logVerbose("line: webhook signature matched multiple accounts");
        res.statusCode = 401;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Ambiguous webhook target" }));
        return;
      }

      const body = parseLineWebhookBody(rawBody);

      if (!body) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Invalid webhook payload" }));
        return;
      }

      if (body.events && body.events.length > 0) {
        logVerbose(`line: received ${body.events.length} webhook events`);
        // Only the admission owner can distinguish queued events from ignored standby deliveries.
        if ((await match.target.bot.handleWebhook(body)) === "durable") {
          res.setHeader("x-openclaw-delivery-accepted", "durable");
        }
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ status: "ok" }));
    } catch (err) {
      if (await rejectLineWebhookRequest(req, res, err)) {
        return;
      }
      params.runtime.error?.(danger(`line webhook error: ${formatErrorMessage(err)}`));
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    }
  };
}
