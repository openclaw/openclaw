/**
 * Minimal Telnyx Messaging client for SMS send + webhook parsing.
 *
 * SMS send goes through /messages with a messaging_profile_id + from
 * (the business's E.164 number). Inbound SMS webhook payloads are
 * parsed in webhook.ts and dispatched to the agent engine.
 */

import type { RuntimeLogger } from "./runtime.js";

const TELNYX_API = "https://api.telnyx.com/v2";

export interface TelnyxMessagingClientOptions {
  apiKey: string;
  messagingProfileId: string;
  fromNumber: string;
  logger: RuntimeLogger;
}

export interface SendSmsParams {
  to: string;
  text: string;
}

export interface SendSmsResult {
  messageId: string;
  raw: unknown;
}

export class TelnyxMessagingClient {
  private readonly apiKey: string;
  private readonly messagingProfileId: string;
  private readonly fromNumber: string;
  private readonly logger: RuntimeLogger;

  constructor(opts: TelnyxMessagingClientOptions) {
    this.apiKey = opts.apiKey;
    this.messagingProfileId = opts.messagingProfileId;
    this.fromNumber = opts.fromNumber;
    this.logger = opts.logger;
  }

  async send(params: SendSmsParams): Promise<SendSmsResult> {
    // Telnyx rejects messages over 1600 chars; SMBs occasionally paste
    // long responses. Truncate with a clear indicator rather than erroring.
    const text =
      params.text.length > 1550 ? `${params.text.slice(0, 1540)}... [truncated]` : params.text;

    const resp = await fetch(`${TELNYX_API}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        from: this.fromNumber,
        to: params.to,
        text,
        messaging_profile_id: this.messagingProfileId,
      }),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`telnyx SMS send failed: ${resp.status} ${resp.statusText} ${body}`);
    }

    const json = (await resp.json()) as {
      data?: { id?: string };
    };
    const messageId = json.data?.id ?? "";
    if (!messageId) {
      this.logger.warn("[missed-call-sms] telnyx SMS send returned no message id");
    }
    return { messageId, raw: json };
  }
}
