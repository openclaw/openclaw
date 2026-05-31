import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as querystring from "node:querystring";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { readRequestBodyWithLimit } from "openclaw/plugin-sdk/webhook-ingress";
import type { ResolvedSmsAccount, SmsInboundMessage, SmsSendResult } from "./types.js";

const TWILIO_ACCOUNTS_URL = "https://api.twilio.com/2010-04-01/Accounts";
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

type TwilioMessagePayload = {
  sid?: string;
  to?: string;
  from?: string;
  status?: string;
};

export type TwilioIncomingPhoneNumber = {
  sid: string;
  phoneNumber: string;
  smsUrl: string;
  smsMethod: string;
  voiceUrl: string;
};

export type TwilioMessageLogEntry = {
  sid: string;
  direction: string;
  status: string;
  to: string;
  from: string;
  errorCode: string;
  body: string;
  dateCreated: string;
  dateSent: string;
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

function firstStringish(value: unknown): string {
  const first = Array.isArray(value) ? value[0] : value;
  if (typeof first === "string") {
    return first;
  }
  return typeof first === "number" ? String(first) : "";
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

function parseTwilioSuccessPayload(text: string): TwilioMessagePayload {
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
      to: typeof record.to === "string" ? record.to : undefined,
      from: typeof record.from === "string" ? record.from : undefined,
      status: typeof record.status === "string" ? record.status : undefined,
    };
  } catch (cause) {
    if (cause instanceof Error && cause.message === "Twilio SMS send returned malformed JSON.") {
      throw cause;
    }
    throw new Error("Twilio SMS send returned malformed JSON.", { cause });
  }
}

function requestSearch(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? "/", "http://localhost").search;
  } catch {
    return "";
  }
}

function configuredUrlHasQuery(url: string): boolean {
  const hashIndex = url.indexOf("#");
  const beforeHash = hashIndex === -1 ? url : url.slice(0, hashIndex);
  return beforeHash.includes("?");
}

export function resolveTwilioWebhookSignatureUrl(params: {
  req: IncomingMessage;
  publicWebhookUrl: string;
}): string {
  if (configuredUrlHasQuery(params.publicWebhookUrl)) {
    return params.publicWebhookUrl;
  }
  const search = requestSearch(params.req);
  if (!search) {
    return params.publicWebhookUrl;
  }
  const hashIndex = params.publicWebhookUrl.indexOf("#");
  if (hashIndex === -1) {
    return `${params.publicWebhookUrl}${search}`;
  }
  return `${params.publicWebhookUrl.slice(0, hashIndex)}${search}${params.publicWebhookUrl.slice(hashIndex)}`;
}

export class TwilioSmsApiError extends Error {
  readonly httpStatus: number;
  readonly responseText: string;
  readonly twilioCode?: number;

  constructor(httpStatus: number, responseText: string, operation = "send") {
    const parsed = parseTwilioApiError(responseText);
    const detail = parsed.message ?? (responseText || "unknown");
    super(`Twilio SMS ${operation} failed (${httpStatus}): ${detail}`);
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
      .toSorted()
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

function twilioApiUrl(accountSid: string, path: string, query?: URLSearchParams): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${TWILIO_ACCOUNTS_URL}/${encodeURIComponent(accountSid)}${normalizedPath}`);
  if (query) {
    url.search = query.toString();
  }
  return url.toString();
}

function basicAuthHeader(account: ResolvedSmsAccount): string {
  return `Basic ${Buffer.from(`${account.accountSid}:${account.authToken}`).toString("base64")}`;
}

async function requestTwilioApi(params: {
  account: ResolvedSmsAccount;
  path: string;
  query?: URLSearchParams;
  init?: RequestInit;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<TwilioApiResponse> {
  const url = twilioApiUrl(params.account.accountSid, params.path, params.query);
  const init = {
    ...params.init,
    headers: {
      authorization: basicAuthHeader(params.account),
      ...(params.init?.headers ?? {}),
    },
  } satisfies RequestInit;
  if (params.fetchImpl) {
    const response = await params.fetchImpl(url, init);
    return {
      ok: response.ok,
      status: response.status,
      text: await response.text(),
    };
  }

  const guarded = await fetchWithSsrFGuard({
    url,
    init,
    auditContext: "sms-twilio-api",
    policy: { allowedHostnames: [TWILIO_API_HOSTNAME] },
    requireHttps: true,
    timeoutMs: params.timeoutMs ?? TWILIO_API_TIMEOUT_MS,
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

function parseTwilioIncomingPhoneNumber(
  record: Record<string, unknown>,
): TwilioIncomingPhoneNumber {
  return {
    sid: firstTrimmedString(record.sid),
    phoneNumber: firstTrimmedString(record.phone_number ?? record.phoneNumber),
    smsUrl: firstTrimmedString(record.sms_url ?? record.smsUrl),
    smsMethod: firstTrimmedString(record.sms_method ?? record.smsMethod),
    voiceUrl: firstTrimmedString(record.voice_url ?? record.voiceUrl),
  };
}

function parseTwilioMessageLogEntry(record: Record<string, unknown>): TwilioMessageLogEntry {
  return {
    sid: firstTrimmedString(record.sid),
    direction: firstTrimmedString(record.direction),
    status: firstTrimmedString(record.status),
    to: firstTrimmedString(record.to),
    from: firstTrimmedString(record.from),
    errorCode: firstStringish(record.error_code ?? record.errorCode).trim(),
    body: firstString(record.body),
    dateCreated: firstTrimmedString(record.date_created ?? record.dateCreated),
    dateSent: firstTrimmedString(record.date_sent ?? record.dateSent),
  };
}

function parseTwilioListPayload<T>(
  text: string,
  key: string,
  parseEntry: (record: Record<string, unknown>) => T,
): T[] {
  if (!text.trim()) {
    return [];
  }
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object") {
    return [];
  }
  const items = (parsed as Record<string, unknown>)[key];
  if (!Array.isArray(items)) {
    return [];
  }
  return items
    .filter((item): item is Record<string, unknown> =>
      Boolean(item && typeof item === "object" && !Array.isArray(item)),
    )
    .map(parseEntry);
}

export async function listTwilioIncomingPhoneNumbers(params: {
  account: ResolvedSmsAccount;
  phoneNumber?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<TwilioIncomingPhoneNumber[]> {
  const query = new URLSearchParams();
  if (params.phoneNumber) {
    query.set("PhoneNumber", params.phoneNumber);
  }
  const response = await requestTwilioApi({
    account: params.account,
    path: "/IncomingPhoneNumbers.json",
    query,
    fetchImpl: params.fetchImpl,
    timeoutMs: params.timeoutMs,
  });
  if (!response.ok) {
    throw new TwilioSmsApiError(response.status, response.text, "phone-number lookup");
  }
  return parseTwilioListPayload(
    response.text,
    "incoming_phone_numbers",
    parseTwilioIncomingPhoneNumber,
  );
}

export async function listTwilioMessages(params: {
  account: ResolvedSmsAccount;
  to?: string;
  from?: string;
  pageSize?: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<TwilioMessageLogEntry[]> {
  const query = new URLSearchParams();
  if (params.to) {
    query.set("To", params.to);
  }
  if (params.from) {
    query.set("From", params.from);
  }
  query.set("PageSize", String(params.pageSize ?? 5));
  const response = await requestTwilioApi({
    account: params.account,
    path: "/Messages.json",
    query,
    fetchImpl: params.fetchImpl,
    timeoutMs: params.timeoutMs,
  });
  if (!response.ok) {
    throw new TwilioSmsApiError(response.status, response.text, "message lookup");
  }
  return parseTwilioListPayload(response.text, "messages", parseTwilioMessageLogEntry);
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
  const init = {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  } satisfies RequestInit;
  const response = await requestTwilioApi({
    account: params.account,
    path: "/Messages.json",
    init,
    fetchImpl: params.fetchImpl,
  });
  if (!response.ok) {
    throw new TwilioSmsApiError(response.status, response.text);
  }
  const payload = parseTwilioSuccessPayload(response.text);
  const sid = payload.sid?.trim();
  if (!sid) {
    throw new Error("Twilio SMS send response did not include a Message SID.");
  }
  return {
    sid,
    to: payload.to?.trim() || params.to,
    ...(payload.from?.trim() ? { from: payload.from.trim() } : {}),
    ...(payload.status?.trim() ? { status: payload.status.trim() } : {}),
  };
}
