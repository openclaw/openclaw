// Rcs plugin module implements twilio behavior.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as querystring from "node:querystring";
import { readRequestBodyWithLimit } from "openclaw/plugin-sdk/webhook-ingress";
import { isRcsWireAddress, toRcsWireAddress } from "./address.js";
import type { TwilioContentCreateRequest, TwilioContentSpec } from "./content.js";
import { requestTwilioApi, TwilioRcsApiError } from "./twilio-api.js";
import type {
  RcsInboundMessage,
  RcsSendResult,
  RcsStatusEvent,
  ResolvedRcsAccount,
} from "./types.js";

const TWILIO_ACCOUNTS_URL = "https://api.twilio.com/2010-04-01/Accounts";
const TWILIO_MESSAGING_URL = "https://messaging.twilio.com/v1";
const TWILIO_CONTENT_URL = "https://content.twilio.com/v1";
const TWILIO_API_HOSTNAME = "api.twilio.com";
const TWILIO_MESSAGING_HOSTNAME = "messaging.twilio.com";
const TWILIO_CONTENT_HOSTNAME = "content.twilio.com";
const WEBHOOK_BODY_LIMIT_BYTES = 64 * 1024;
const WEBHOOK_BODY_TIMEOUT_MS = 5_000;
const MAX_INBOUND_MEDIA_URLS = 10;

type TwilioMessagePayload = {
  sid?: string;
  to?: string;
  from?: string;
  status?: string;
};

export type TwilioMessagingService = {
  sid: string;
  inboundRequestUrl: string;
  inboundMethod: string;
  useInboundWebhookOnNumber: boolean;
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

function parseTwilioSuccessPayload(text: string): TwilioMessagePayload {
  if (!text.trim()) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") {
      throw new Error("Twilio RCS send returned malformed JSON.");
    }
    const record = parsed as Record<string, unknown>;
    return {
      sid: typeof record.sid === "string" ? record.sid : undefined,
      to: typeof record.to === "string" ? record.to : undefined,
      from: typeof record.from === "string" ? record.from : undefined,
      status: typeof record.status === "string" ? record.status : undefined,
    };
  } catch (cause) {
    if (cause instanceof Error && cause.message === "Twilio RCS send returned malformed JSON.") {
      throw cause;
    }
    throw new Error("Twilio RCS send returned malformed JSON.", { cause });
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

export function resolveRcsStatusCallbackUrl(publicWebhookUrl: string): string {
  const trimmed = publicWebhookUrl.trim().replace(/\/+$/, "");
  return trimmed ? `${trimmed}/status` : "";
}

export function parseTwilioFormBody(body: string): Record<string, string> {
  const parsed = querystring.parse(body);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    out[key] = firstString(value);
  }
  return out;
}

function computeTwilioSignature(params: {
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

function collectInboundMediaUrls(form: Record<string, string>): string[] {
  const numMedia = Number.parseInt(form.NumMedia ?? "0", 10);
  if (!Number.isSafeInteger(numMedia) || numMedia <= 0) {
    return [];
  }
  const urls: string[] = [];
  for (let i = 0; i < Math.min(numMedia, MAX_INBOUND_MEDIA_URLS); i += 1) {
    const url = firstTrimmedString(form[`MediaUrl${i}`]);
    if (url) {
      urls.push(url);
    }
  }
  return urls;
}

export function buildTwilioInboundMessage(form: Record<string, string>): RcsInboundMessage | null {
  const from = firstTrimmedString(form.From);
  const to = firstTrimmedString(form.To);
  const body = firstString(form.Body) || firstString(form.ButtonText);
  const buttonPayload = firstTrimmedString(form.ButtonPayload);
  const mediaUrls = collectInboundMediaUrls(form);
  const accountSid = firstTrimmedString(form.AccountSid);
  const messageSid =
    firstTrimmedString(form.MessageSid) ||
    firstTrimmedString(form.SmsSid) ||
    firstTrimmedString(form.SmsMessageSid);
  // A suggested-reply / postback tap can arrive with only ButtonPayload and no
  // display text, so a bare payload still counts as inbound content.
  if (!from || !to || !messageSid || (!body && mediaUrls.length === 0 && !buttonPayload)) {
    return null;
  }
  return {
    accountSid,
    from,
    to,
    body,
    messageSid,
    mediaUrls,
    ...(buttonPayload ? { buttonPayload } : {}),
    viaRcs: isRcsWireAddress(from),
  };
}

export function buildTwilioStatusEvent(form: Record<string, string>): RcsStatusEvent | null {
  const messageSid = firstTrimmedString(form.MessageSid) || firstTrimmedString(form.SmsSid);
  const reportedStatus =
    firstTrimmedString(form.MessageStatus) || firstTrimmedString(form.SmsStatus);
  // Read receipts arrive as a post-delivery EventType=READ callback (RCS/WhatsApp),
  // which can carry a stale MessageStatus, so READ wins over the reported status.
  const eventType = firstTrimmedString(form.EventType);
  const status = eventType.toUpperCase() === "READ" ? "read" : reportedStatus;
  if (!messageSid || !status) {
    return null;
  }
  const errorCode = firstStringish(form.ErrorCode).trim();
  return {
    messageSid,
    status,
    to: firstTrimmedString(form.To),
    ...(errorCode ? { errorCode } : {}),
    timestamp: Date.now(),
  };
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

function twilioMessagingUrl(path: string, query?: URLSearchParams): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${TWILIO_MESSAGING_URL}${normalizedPath}`);
  if (query) {
    url.search = query.toString();
  }
  return url.toString();
}

function parseTwilioMessagingService(record: Record<string, unknown>): TwilioMessagingService {
  return {
    sid: firstTrimmedString(record.sid),
    inboundRequestUrl: firstTrimmedString(record.inbound_request_url ?? record.inboundRequestUrl),
    inboundMethod: firstTrimmedString(record.inbound_method ?? record.inboundMethod),
    useInboundWebhookOnNumber: Boolean(
      record.use_inbound_webhook_on_number ?? record.useInboundWebhookOnNumber,
    ),
  };
}

export async function retrieveTwilioMessagingService(params: {
  account: ResolvedRcsAccount;
  serviceSid: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<TwilioMessagingService> {
  const response = await requestTwilioApi({
    account: params.account,
    url: twilioMessagingUrl(`/Services/${encodeURIComponent(params.serviceSid)}`),
    allowedHostname: TWILIO_MESSAGING_HOSTNAME,
    fetchImpl: params.fetchImpl,
    timeoutMs: params.timeoutMs,
  });
  if (!response.ok) {
    throw new TwilioRcsApiError(response.status, response.text, "messaging-service lookup");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    throw new Error("Twilio Messaging Service lookup returned malformed JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Twilio Messaging Service lookup returned malformed JSON.");
  }
  return parseTwilioMessagingService(parsed as Record<string, unknown>);
}

function resolveRcsSendAddress(params: { account: ResolvedRcsAccount; to: string }): string {
  // rcs-only targets the RCS transport explicitly; rcs-preferred sends a bare
  // E.164 so Twilio attempts RCS first and falls back to SMS/MMS.
  return params.account.transport === "rcs-only" ? toRcsWireAddress(params.to) : params.to;
}

export async function sendRcsViaTwilio(params: {
  account: ResolvedRcsAccount;
  to: string;
  text?: string;
  mediaUrls?: string[];
  fetchImpl?: typeof fetch;
}): Promise<RcsSendResult> {
  if (!params.account.messagingServiceSid && !params.account.senderId) {
    throw new Error("Twilio RCS send requires messagingServiceSid or senderId.");
  }
  if (!params.text && !(params.mediaUrls && params.mediaUrls.length)) {
    throw new Error("Twilio RCS send requires text or media.");
  }
  const wireTo = resolveRcsSendAddress({ account: params.account, to: params.to });
  const body = new URLSearchParams({ To: wireTo });
  if (params.text) {
    body.set("Body", params.text);
  }
  for (const mediaUrl of params.mediaUrls ?? []) {
    body.append("MediaUrl", mediaUrl);
  }
  if (params.account.messagingServiceSid) {
    body.set("MessagingServiceSid", params.account.messagingServiceSid);
  } else {
    body.set("From", params.account.senderId);
  }
  if (params.account.statusCallbacks && params.account.publicWebhookUrl) {
    body.set("StatusCallback", resolveRcsStatusCallbackUrl(params.account.publicWebhookUrl));
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
    url: twilioApiUrl(params.account.accountSid, "/Messages.json"),
    allowedHostname: TWILIO_API_HOSTNAME,
    init,
    fetchImpl: params.fetchImpl,
  });
  if (!response.ok) {
    throw new TwilioRcsApiError(response.status, response.text);
  }
  const payload = parseTwilioSuccessPayload(response.text);
  const sid = payload.sid?.trim();
  if (!sid) {
    throw new Error("Twilio RCS send response did not include a Message SID.");
  }
  return {
    sid,
    to: payload.to?.trim() || wireTo,
    ...(payload.from?.trim() ? { from: payload.from.trim() } : {}),
    ...(payload.status?.trim() ? { status: payload.status.trim() } : {}),
  };
}

function twilioContentUrl(path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return new URL(`${TWILIO_CONTENT_URL}${normalizedPath}`).toString();
}

/**
 * Creates a Twilio Content Template from a build request and returns its
 * ContentSid (HX...). RCS rich content is sent by referencing a ContentSid, so
 * each rich outbound message first materializes its template here.
 */
async function createTwilioContent(params: {
  account: ResolvedRcsAccount;
  request: TwilioContentCreateRequest;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const response = await requestTwilioApi({
    account: params.account,
    url: twilioContentUrl("/Content"),
    allowedHostname: TWILIO_CONTENT_HOSTNAME,
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params.request),
    },
    fetchImpl: params.fetchImpl,
  });
  if (!response.ok) {
    throw new TwilioRcsApiError(response.status, response.text, "content create");
  }
  const payload = parseTwilioSuccessPayload(response.text);
  const sid = payload.sid?.trim();
  if (!sid) {
    throw new Error("Twilio RCS content create response did not include a ContentSid.");
  }
  return sid;
}

/**
 * Sends a rich RCS message: creates the content template, then posts the
 * resulting ContentSid plus ContentVariables to the Messages API instead of a
 * plain Body. Falls back through the same messaging-service/sender and
 * status-callback wiring as a plain text send.
 */
export async function sendRcsContentViaTwilio(params: {
  account: ResolvedRcsAccount;
  to: string;
  content: TwilioContentSpec;
  fetchImpl?: typeof fetch;
}): Promise<RcsSendResult> {
  if (!params.account.messagingServiceSid && !params.account.senderId) {
    throw new Error("Twilio RCS send requires messagingServiceSid or senderId.");
  }
  const contentSid = await createTwilioContent({
    account: params.account,
    request: params.content.request,
    fetchImpl: params.fetchImpl,
  });
  const wireTo = resolveRcsSendAddress({ account: params.account, to: params.to });
  const body = new URLSearchParams({ To: wireTo, ContentSid: contentSid });
  if (Object.keys(params.content.variables).length > 0) {
    body.set("ContentVariables", JSON.stringify(params.content.variables));
  }
  if (params.account.messagingServiceSid) {
    body.set("MessagingServiceSid", params.account.messagingServiceSid);
  } else {
    body.set("From", params.account.senderId);
  }
  if (params.account.statusCallbacks && params.account.publicWebhookUrl) {
    body.set("StatusCallback", resolveRcsStatusCallbackUrl(params.account.publicWebhookUrl));
  }
  const response = await requestTwilioApi({
    account: params.account,
    url: twilioApiUrl(params.account.accountSid, "/Messages.json"),
    allowedHostname: TWILIO_API_HOSTNAME,
    init: {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    },
    fetchImpl: params.fetchImpl,
  });
  if (!response.ok) {
    throw new TwilioRcsApiError(response.status, response.text);
  }
  const payload = parseTwilioSuccessPayload(response.text);
  const sid = payload.sid?.trim();
  if (!sid) {
    throw new Error("Twilio RCS content send response did not include a Message SID.");
  }
  return {
    sid,
    to: payload.to?.trim() || wireTo,
    ...(payload.from?.trim() ? { from: payload.from.trim() } : {}),
    ...(payload.status?.trim() ? { status: payload.status.trim() } : {}),
  };
}
