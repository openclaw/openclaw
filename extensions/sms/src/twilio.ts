import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as querystring from "node:querystring";
import { readRequestBodyWithLimit } from "openclaw/plugin-sdk/webhook-ingress";
import type { ResolvedSmsAccount, SmsInboundMessage, SmsSendResult } from "./types.js";

const TWILIO_MESSAGES_URL = "https://api.twilio.com/2010-04-01/Accounts";
const WEBHOOK_BODY_LIMIT_BYTES = 32 * 1024;
const WEBHOOK_BODY_TIMEOUT_MS = 5_000;

function firstString(value: unknown): string {
  if (Array.isArray(value)) {
    return firstString(value[0]);
  }
  return typeof value === "string" ? value : "";
}

function firstTrimmedString(value: unknown): string {
  return firstString(value).trim();
}

export function parseTwilioFormBody(body: string): Record<string, string> {
  const parsed = querystring.parse(body);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    out[key] = firstString(value);
  }
  return out;
}

export function computeTwilioSignature(params: {
  url: string;
  authToken: string;
  form: Record<string, string>;
}): string {
  const data =
    params.url +
    Object.keys(params.form)
      .sort()
      .map((key) => `${key}${params.form[key] ?? ""}`)
      .join("");
  return createHmac("sha1", params.authToken).update(data).digest("base64");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function verifyTwilioSignature(params: {
  signature: string | undefined;
  url: string;
  authToken: string;
  form: Record<string, string>;
}): boolean {
  if (!params.signature || !params.url || !params.authToken) {
    return false;
  }
  return safeEqual(
    params.signature,
    computeTwilioSignature({
      url: params.url,
      authToken: params.authToken,
      form: params.form,
    }),
  );
}

export function buildTwilioInboundMessage(form: Record<string, string>): SmsInboundMessage | null {
  const from = firstTrimmedString(form.From);
  const to = firstTrimmedString(form.To);
  const body = firstString(form.Body);
  const messageSid = firstTrimmedString(form.MessageSid) || firstTrimmedString(form.SmsSid);
  if (!from || !to || !body || !messageSid) {
    return null;
  }
  return { from, to, body, messageSid };
}

export async function readTwilioWebhookForm(req: IncomingMessage): Promise<Record<string, string>> {
  const body = await readRequestBodyWithLimit(req, {
    maxBytes: WEBHOOK_BODY_LIMIT_BYTES,
    timeoutMs: WEBHOOK_BODY_TIMEOUT_MS,
  });
  return parseTwilioFormBody(body);
}

export function respondTwiml(res: ServerResponse, statusCode: number, body = ""): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "text/xml; charset=utf-8");
  res.end(body || "<Response></Response>");
}

export async function sendSmsViaTwilio(params: {
  account: ResolvedSmsAccount;
  to: string;
  text: string;
  fetchImpl?: typeof fetch;
}): Promise<SmsSendResult> {
  const fetcher = params.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    From: params.account.fromNumber,
    To: params.to,
    Body: params.text,
  });
  const auth = Buffer.from(`${params.account.accountSid}:${params.account.authToken}`).toString(
    "base64",
  );
  const response = await fetcher(
    `${TWILIO_MESSAGES_URL}/${encodeURIComponent(params.account.accountSid)}/Messages.json`,
    {
      method: "POST",
      headers: {
        authorization: `Basic ${auth}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    },
  );
  const payload = (await response.json().catch(() => ({}))) as { sid?: string; message?: string };
  if (!response.ok) {
    throw new Error(`Twilio SMS send failed (${response.status}): ${payload.message ?? "unknown"}`);
  }
  return {
    sid: payload.sid ?? `sms-${Date.now()}`,
    to: params.to,
  };
}
