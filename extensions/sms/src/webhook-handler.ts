/**
 * Inbound webhook handler for SMS messages forwarded from the hub.
 * Receives the raw Quo (OpenPhone) webhook payload.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
} from "openclaw/plugin-sdk/sms";

const PREAUTH_MAX_BODY_BYTES = 64 * 1024;
const PREAUTH_BODY_TIMEOUT_MS = 5_000;

/** Read the full request body as a string. */
async function readBody(req: IncomingMessage): Promise<
  | { ok: true; body: string }
  | { ok: false; statusCode: number; error: string }
> {
  try {
    const body = await readRequestBodyWithLimit(req, {
      maxBytes: PREAUTH_MAX_BODY_BYTES,
      timeoutMs: PREAUTH_BODY_TIMEOUT_MS,
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
    return { ok: false, statusCode: 400, error: "Invalid request body" };
  }
}

function respondJson(res: ServerResponse, statusCode: number, body: Record<string, unknown>) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export interface SmsWebhookHandlerDeps {
  deliver: (msg: {
    body: string;
    from: string;
    provider: string;
    chatType: string;
    accountId: string;
    commandAuthorized: boolean;
  }) => Promise<string | null>;
  log?: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}

/**
 * Create an HTTP request handler for SMS webhooks forwarded from the hub.
 *
 * 1. Parse JSON body (Quo webhook payload)
 * 2. Validate message.received event type
 * 3. Extract sender phone and text
 * 4. Deliver to agent
 * 5. ACK with 200
 */
export function createSmsWebhookHandler(deps: SmsWebhookHandlerDeps) {
  const { deliver, log } = deps;

  return async (req: IncomingMessage, res: ServerResponse) => {
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

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(bodyResult.body) as Record<string, unknown>;
    } catch {
      respondJson(res, 400, { error: "Invalid JSON" });
      return;
    }

    // Only handle message.received events
    if (payload.type !== "message.received") {
      respondJson(res, 200, { ok: true });
      return;
    }

    const data = payload.data as Record<string, unknown> | undefined;
    const object = data?.object as Record<string, unknown> | undefined;
    const fromPhone = object?.from as string | undefined;
    const text = object?.text as string | undefined;

    if (!fromPhone || !text) {
      respondJson(res, 400, { error: "Missing from or text in payload" });
      return;
    }

    const preview = text.length > 100 ? `${text.slice(0, 100)}...` : text;
    log?.info(`SMS from ${fromPhone}: ${preview}`);

    // ACK immediately
    respondJson(res, 200, { ok: true });

    // Deliver to agent asynchronously
    try {
      await deliver({
        body: text,
        from: fromPhone,
        provider: "sms",
        chatType: "direct",
        accountId: "default",
        commandAuthorized: true,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log?.error(`Failed to process SMS from ${fromPhone}: ${errMsg}`);
    }
  };
}
