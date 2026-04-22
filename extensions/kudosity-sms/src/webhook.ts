/**
 * Kudosity SMS inbound webhook handler for OpenClaw.
 *
 * Receives SMS_INBOUND webhook events from Kudosity and routes them
 * into OpenClaw's conversation system.
 *
 * Webhook setup:
 * 1. In your Kudosity dashboard, create a webhook for SMS_INBOUND events
 * 2. Point it to: https://your-openclaw-instance/api/channels/kudosity-sms/webhook
 *
 * Note: Kudosity webhooks do not currently support payload signing or shared
 * secrets. Security relies on endpoint URL obscurity. Consider IP allowlisting
 * at the network/reverse-proxy level if your deployment requires it.
 *
 * @see https://developers.kudosity.com/reference/post_v2-webhook
 * @see https://developers.kudosity.com/reference/about-webhooks
 */

import type { InboundSMSEvent } from "./kudosity-api.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Kudosity webhook payload for SMS_INBOUND events.
 *
 * This is the shape of the JSON body that Kudosity POSTs to our endpoint
 * when an inbound SMS is received on the virtual number.
 */
export interface KudosityWebhookPayload {
  /** Event type (e.g., "SMS_INBOUND", "SMS_STATUS", "OPT_OUT") */
  event_type: string;
  /** Event data — varies by event type */
  data: InboundSMSEvent | Record<string, unknown>;
  /** Timestamp of the event */
  timestamp: string;
}

/**
 * Normalized inbound message for OpenClaw's conversation system.
 */
export interface InboundMessage {
  /** Channel identifier */
  channel: "kudosity-sms";
  /** Sender's phone number (the user) */
  from: string;
  /** Recipient number (the Kudosity virtual number) */
  to: string;
  /** Message text */
  text: string;
  /** Unique message ID from Kudosity */
  messageId: string;
  /** Original timestamp */
  timestamp: string;
}

// ─── Webhook Processing ──────────────────────────────────────────────────────

/**
 * Parse and validate a Kudosity webhook payload.
 *
 * @param body - Raw request body (parsed JSON)
 * @returns Parsed webhook payload, or null if invalid
 */
export function parseWebhookPayload(body: unknown): KudosityWebhookPayload | null {
  if (!body || typeof body !== "object") {
    return null;
  }

  const payload = body as Record<string, unknown>;

  if (!payload.event_type || typeof payload.event_type !== "string") {
    return null;
  }

  if (!payload.data || typeof payload.data !== "object") {
    return null;
  }

  return payload as unknown as KudosityWebhookPayload;
}

/**
 * Check if a webhook payload is an inbound SMS event.
 */
export function isInboundSMS(payload: KudosityWebhookPayload): boolean {
  return payload.event_type === "SMS_INBOUND";
}

/**
 * Check if a webhook payload is an opt-out event.
 */
export function isOptOut(payload: KudosityWebhookPayload): boolean {
  return payload.event_type === "OPT_OUT";
}

/**
 * Check if a webhook payload is an SMS status update.
 */
export function isSMSStatus(payload: KudosityWebhookPayload): boolean {
  return payload.event_type === "SMS_STATUS";
}

/**
 * Convert a Kudosity inbound SMS webhook event into an OpenClaw inbound message.
 *
 * @param payload - Kudosity webhook payload (must be SMS_INBOUND type)
 * @returns Normalized inbound message for OpenClaw, or null if invalid
 */
export function toInboundMessage(payload: KudosityWebhookPayload): InboundMessage | null {
  if (!isInboundSMS(payload)) {
    return null;
  }

  const data = payload.data as InboundSMSEvent;

  if (
    typeof data.sender !== "string" ||
    typeof data.recipient !== "string" ||
    typeof data.message !== "string" ||
    typeof data.id !== "string" ||
    !data.sender.trim() ||
    !data.recipient.trim() ||
    !data.message.trim() ||
    !data.id.trim()
  ) {
    return null;
  }

  // Prefer `data.created_at` and fall back to `payload.timestamp`, but only
  // accept either when it is a non-empty string. A malformed or spoofed
  // webhook body can carry an object/number here, and downstream consumers
  // (serialization, date parsing, audit logs) treat `timestamp` as a string.
  const timestamp = pickStringTimestamp(data.created_at, payload.timestamp);
  if (timestamp === null) {
    return null;
  }

  return {
    channel: "kudosity-sms",
    from: data.sender,
    to: data.recipient,
    text: data.message,
    messageId: data.id,
    timestamp,
  };
}

function pickStringTimestamp(...candidates: unknown[]): string | null {
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return null;
}

/**
 * Express/Connect-style request handler for Kudosity webhooks.
 *
 * This is a reference implementation showing how the webhook endpoint
 * should process incoming requests. In the actual OpenClaw integration,
 * this would be registered as a gateway route.
 *
 * @example
 * ```typescript
 * // In the channel's gateway adapter:
 * app.post("/api/channels/kudosity-sms/webhook", (req, res) => {
 *   const message = handleWebhookRequest(req.body);
 *   if (message) {
 *     // Route to OpenClaw conversation system
 *     runtime.channel["kudosity-sms"].handleInbound(message);
 *   }
 *   res.status(200).json({ ok: true });
 * });
 * ```
 */
export function handleWebhookRequest(body: unknown): InboundMessage | null {
  const payload = parseWebhookPayload(body);
  if (!payload) {
    return null;
  }

  // Only process inbound SMS events
  if (!isInboundSMS(payload)) {
    // Acknowledge other event types but don't process them
    return null;
  }

  return toInboundMessage(payload);
}
