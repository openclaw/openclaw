import type { IncomingMessage, ServerResponse } from "node:http";
import {
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
} from "openclaw/plugin-sdk/webhook-ingress";
import { Webhook } from "svix";
import type { AgentMailIngressRecord, ResolvedAgentMailAccount } from "./types.js";

const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

type WebhookLog = {
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function respond(res: ServerResponse, status: number, body = ""): true {
  res.statusCode = status;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end(body);
  return true;
}

function parseVerifiedEvent(payload: unknown): {
  eventId?: string;
  inboxId: string;
  messageId: string;
} | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const event = payload as Record<string, unknown>;
  const message = event.message;
  if (!message || typeof message !== "object") {
    return null;
  }
  const mail = message as Record<string, unknown>;
  if (typeof mail.inbox_id !== "string" || typeof mail.message_id !== "string") {
    return null;
  }
  return {
    inboxId: mail.inbox_id,
    messageId: mail.message_id,
    ...(typeof event.event_id === "string" ? { eventId: event.event_id } : {}),
  };
}

export function createAgentMailWebhookHandler(params: {
  account: ResolvedAgentMailAccount;
  receive: (record: AgentMailIngressRecord) => Promise<void>;
  log?: WebhookLog;
}) {
  const verifier = new Webhook(params.account.webhookSecret);
  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") {
      res.setHeader("allow", "POST");
      return respond(res, 405, "Method not allowed");
    }
    let rawBody: string;
    try {
      rawBody = await readRequestBodyWithLimit(req, { maxBytes: MAX_WEBHOOK_BODY_BYTES });
    } catch (error) {
      return respond(res, isRequestBodyLimitError(error) ? 413 : 400, "Invalid request body");
    }
    let verified: unknown;
    try {
      const headers = {
        "svix-id": header(req, "svix-id") ?? "",
        "svix-timestamp": header(req, "svix-timestamp") ?? "",
        "svix-signature": header(req, "svix-signature") ?? "",
      };
      verified = verifier.verify(Buffer.from(rawBody), headers);
    } catch {
      params.log?.warn?.("AgentMail webhook rejected an invalid signature");
      return respond(res, 401, "Invalid signature");
    }
    const eventType =
      verified && typeof verified === "object"
        ? (verified as Record<string, unknown>).event_type
        : undefined;
    if (typeof eventType !== "string") {
      params.log?.warn?.("AgentMail webhook ignored a signed event without an event type");
      return respond(res, 200);
    }
    if (eventType !== "message.received") {
      params.log?.warn?.(
        `AgentMail webhook ignored signed event type ${JSON.stringify(eventType)}`,
      );
      return respond(res, 200);
    }
    const event = parseVerifiedEvent(verified);
    if (!event) {
      // Signature verification succeeded, but retrying cannot repair a provider payload shape.
      params.log?.warn?.("AgentMail webhook ignored a malformed signed received event");
      return respond(res, 200);
    }
    if (event.inboxId !== params.account.inboxId) {
      // The signature is valid but this route cannot ever own the inbox. Acknowledge permanently
      // so provider retries cannot amplify a routing/configuration error.
      params.log?.warn?.("AgentMail webhook ignored an event for the wrong inbox");
      return respond(res, 200);
    }
    try {
      await params.receive({
        accountId: params.account.accountId,
        inboxId: event.inboxId,
        messageId: event.messageId,
        eventId: event.eventId,
        transport: "webhook",
        receivedAt: Date.now(),
      });
      return respond(res, 200);
    } catch (error) {
      params.log?.error?.(
        `AgentMail durable webhook commit failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return respond(res, 503, "Retry later");
    }
  };
}
