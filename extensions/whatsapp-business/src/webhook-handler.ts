/**
 * Inbound webhook handler for WhatsApp Business messages forwarded from the hub.
 * Receives the raw Meta WhatsApp Business webhook payload.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
} from "openclaw/plugin-sdk/whatsapp-business";

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

export interface WhatsAppBusinessWebhookHandlerDeps {
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
 * Create an HTTP request handler for WhatsApp Business webhooks forwarded from the hub.
 *
 * 1. Parse JSON body (Meta webhook payload)
 * 2. Extract messages from entry[].changes[].value.messages[]
 * 3. Deliver each message to agent
 * 4. ACK with 200
 */
export function createWhatsAppBusinessWebhookHandler(deps: WhatsAppBusinessWebhookHandlerDeps) {
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

    // Extract messages from Meta's nested payload structure
    const entries = payload.entry as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(entries)) {
      respondJson(res, 200, { ok: true });
      return;
    }

    // ACK immediately
    respondJson(res, 200, { ok: true });

    // Process messages asynchronously
    for (const entry of entries) {
      const changes = entry.changes as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(changes)) continue;

      for (const change of changes) {
        const value = change.value as Record<string, unknown> | undefined;
        if (!value) continue;

        const msgs = value.messages as Array<Record<string, unknown>> | undefined;
        if (!Array.isArray(msgs)) continue;

        for (const msg of msgs) {
          const from = msg.from as string | undefined;
          const textObj = msg.text as { body?: string } | undefined;
          const text = textObj?.body;

          if (!from || !text) continue;

          const preview = text.length > 100 ? `${text.slice(0, 100)}...` : text;
          log?.info(`WhatsApp Business from ${from}: ${preview}`);

          try {
            await deliver({
              body: text,
              from,
              provider: "whatsapp-business",
              chatType: "direct",
              accountId: "default",
              commandAuthorized: true,
            });
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            log?.error(`Failed to process WhatsApp Business message from ${from}: ${errMsg}`);
          }
        }
      }
    }
  };
}
