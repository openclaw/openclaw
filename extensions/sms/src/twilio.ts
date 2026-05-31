import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as querystring from "node:querystring";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { readRequestBodyWithLimit } from "openclaw/plugin-sdk/webhook-ingress";
import type { ResolvedSmsAccount, SmsInboundMessage, SmsSendResult } from "./types.js";

const TWILIO_MESSAGES_URL = "https://api.twilio.com/2010-04-01/Accounts";
const TWILIO_API_HOSTNAME = "api.twilio.com";
const TWILIO_API_TIMEOUT_MS = 30_000;
const WEBHOOK_BODY_LIMIT_BYTES = 32 * 1024;
const WEBHOOK_BODY_TIMEOUT_MS = 5_000;

type ParsedTwilioApiError = {
  code?: number;
  message?: string;
};

type TwilioApiResponse = {
  ok: boolean;
  status: number;
  text: string;
};

function firstString(value: unknown): string {
  if (Array.isArray(value)) {
    return firstString(value[0]);
  }
  return typeof value === "string" ? value : "";
}

function firstTrimmedString(value: unknown): string {
  return firstString(value).trim();
}

function parseTwilioApiError(text: string): ParsedTwilioApiError {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    const record = parsed as Record<string, unknown>;
    return {
      code: typeof record.code === "number" ? record.code : undefined,
      message: typeof record.message === "string" ? record.message : undefined,
    };
  } catch {
    return {};
  }
}

function parseTwilioSuccessPayload(text: string): { sid?: string } {
  if (!text.trim()) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") {
      throw new Error("Twilio SMS send returned malformed JSON.");
    }
    const record = parsed as Record<string, unknown>;
    return {
      sid: typeof record.sid === "string" ? record.sid : undefined,
    };
  } catch (err) {
    if (err instanceof Error && err.message === "Twilio SMS send returned malformed JSON.") {
      throw err;
    }
    throw new Error("Twilio SMS send returned malformed JSON.");
  }
}

export class TwilioSmsApiError extends Error {
  readonly httpStatus: number;
  readonly responseText: string;
  readonly twilioCode?: number;

  constructor(httpStatus: number, responseText: string) {
    const parsed = parseTwilioApiError(responseText);
    const detail = parsed.message ?? (responseText || "unknown");
    super(`Twilio SMS send failed (${httpStatus}): ${detail}`);
    this.name = "TwilioSmsApiError";
    this.httpStatus = httpStatus;
    this.responseText = responseText;
    this.twilioCode = parsed.code;
  }
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
  const accountSid = firstTrimmedString(form.AccountSid);
  const messageSid =
    firstTrimmedString(form.MessageSid) ||
    firstTrimmedString(form.SmsSid) ||
    firstTrimmedString(form.SmsMessageSid);
  if (!from || !to || !body || !messageSid) {
    return null;
  }
  return { accountSid, from, to, body, messageSid };
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

async function postTwilioMessages(params: {
  url: string;
  init: RequestInit;
  fetchImpl?: typeof fetch;
}): Promise<TwilioApiResponse> {
  if (params.fetchImpl) {
    const response = await params.fetchImpl(params.url, params.init);
    return {
      ok: response.ok,
      status: response.status,
      text: await response.text(),
    };
  }

  const guarded = await fetchWithSsrFGuard({
    url: params.url,
    init: params.init,
    auditContext: "sms-twilio-api",
    policy: { allowedHostnames: [TWILIO_API_HOSTNAME] },
    requireHttps: true,
    timeoutMs: TWILIO_API_TIMEOUT_MS,
  });
  try {
    return {
      ok: guarded.response.ok,
      status: guarded.response.status,
      text: await guarded.response.text(),
    };
  } finally {
    await guarded.release();
  }
}

export async function sendSmsViaTwilio(params: {
  account: ResolvedSmsAccount;
  to: string;
  text: string;
  fetchImpl?: typeof fetch;
}): Promise<SmsSendResult> {
  if (!params.account.fromNumber && !params.account.messagingServiceSid) {
    throw new Error("Twilio SMS send requires fromNumber or messagingServiceSid.");
  }
  const body = new URLSearchParams({
    To: params.to,
    Body: params.text,
  });
  if (params.account.fromNumber) {
    body.set("From", params.account.fromNumber);
  } else {
    body.set("MessagingServiceSid", params.account.messagingServiceSid);
  }
  const auth = Buffer.from(`${params.account.accountSid}:${params.account.authToken}`).toString(
    "base64",
  );
  const url = `${TWILIO_MESSAGES_URL}/${encodeURIComponent(params.account.accountSid)}/Messages.json`;
  const init = {
    method: "POST",
    headers: {
      authorization: `Basic ${auth}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  } satisfies RequestInit;
  const response = await postTwilioMessages({ url, init, fetchImpl: params.fetchImpl });
  if (!response.ok) {
    throw new TwilioSmsApiError(response.status, response.text);
  }
  const payload = parseTwilioSuccessPayload(response.text);
  return {
    sid: payload.sid ?? `sms-${Date.now()}`,
    to: params.to,
  };
}
