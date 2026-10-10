import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as querystring from "node:querystring";
import {
  formatErrorMessage,
  PlatformMessageNotDispatchedError,
} from "openclaw/plugin-sdk/error-runtime";
import { captureEffectAuthority } from "openclaw/plugin-sdk/fetch-runtime";
import { redactToolPayloadText } from "openclaw/plugin-sdk/logging-core";
import {
  readResponseTextPrefix,
  readResponseWithLimit,
} from "openclaw/plugin-sdk/response-limit-runtime";
import { safeEqualSecret } from "openclaw/plugin-sdk/security-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { asNullableObjectRecord, isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { safeParseJson } from "openclaw/plugin-sdk/text-utility-runtime";
import { readRequestBodyWithLimit } from "openclaw/plugin-sdk/webhook-ingress";
import { assertSmsCredentialOwnerAvailable } from "./credential-availability.js";
import { looksLikeSmsPhoneNumber, normalizeSmsPhoneNumber } from "./phone.js";
import { resolveTwilioStatusCallbackUrl } from "./public-webhook-url.js";
import type { ResolvedSmsAccount, SmsInboundMessage, SmsSendResult } from "./types.js";

const TWILIO_ACCOUNTS_URL = "https://api.twilio.com/2010-04-01/Accounts";
const TWILIO_MESSAGING_URL = "https://messaging.twilio.com/v1";
const TWILIO_API_HOSTNAME = "api.twilio.com";
const TWILIO_MESSAGING_HOSTNAME = "messaging.twilio.com";
const TWILIO_API_TIMEOUT_MS = 30_000;
const TWILIO_API_SUCCESS_BODY_LIMIT_BYTES = 1 * 1024 * 1024;
const TWILIO_API_ERROR_BODY_LIMIT_BYTES = 8 * 1024;
const TRUNCATED_RESPONSE_SUFFIX = "... [truncated]";
const WEBHOOK_BODY_LIMIT_BYTES = 32 * 1024;
const WEBHOOK_BODY_TIMEOUT_MS = 5_000;
export const TWILIO_MESSAGE_BODY_MAX_LENGTH = 1600;
const TWILIO_MMS_MAX_OUTBOUND_MEDIA_COUNT = 10;
export const TWILIO_MMS_MAX_BYTES = 5 * 1024 * 1024;
const SMS_MAX_INBOUND_MEDIA_DOWNLOADS = 10;

type ParsedTwilioApiError = {
  code?: number;
  message?: string;
};

type TwilioMessagePayload = {
  sid?: string;
  to?: string;
  from?: string;
  status?: string;
};

const TWILIO_CHANNEL_ADDRESS_RE = /^([a-z][a-z0-9-]*):(.*)$/i;

export type TwilioIncomingPhoneNumber = ReturnType<typeof parseTwilioIncomingPhoneNumber>;
export type TwilioMessageLogEntry = ReturnType<typeof parseTwilioMessageLogEntry>;
export type TwilioMessagingService = ReturnType<typeof parseTwilioMessagingService>;

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
  const record = asNullableObjectRecord(safeParseJson<unknown>(text));
  if (!record) {
    return {};
  }
  return {
    code: typeof record.code === "number" ? record.code : undefined,
    message: typeof record.message === "string" ? record.message : undefined,
  };
}

function parseTwilioSuccessPayload(text: string): TwilioMessagePayload {
  if (!text.trim()) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error("Twilio SMS send returned malformed JSON.", { cause });
  }
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
}

function requestSearch(req: IncomingMessage): string {
  return URL.parse(req.url ?? "/", "http://localhost")?.search ?? "";
}

function stripUrlFragment(url: string): string {
  const hashIndex = url.indexOf("#");
  return hashIndex === -1 ? url : url.slice(0, hashIndex);
}

export function resolveTwilioWebhookSignatureUrl(params: {
  req: IncomingMessage;
  publicWebhookUrl: string;
}): string {
  // Twilio connection overrides live in the fragment but are excluded from its
  // signature input. Strip without URL reserialization so exact port/path bytes survive.
  const signatureBaseUrl = stripUrlFragment(params.publicWebhookUrl);
  if (signatureBaseUrl.includes("?")) {
    return signatureBaseUrl;
  }
  const search = requestSearch(params.req);
  if (!search) {
    return signatureBaseUrl;
  }
  return `${signatureBaseUrl}${search}`;
}

class TwilioSmsApiError extends Error {
  readonly httpStatus: number;
  readonly responseText: string;
  readonly twilioCode?: number;

  constructor(httpStatus: number, responseText: string, operation = "send") {
    // Remote error bodies can reflect request credentials. Redact once before
    // exposing the body through either the message or the structured field.
    const redactedResponseText = redactToolPayloadText(responseText);
    const parsed = parseTwilioApiError(redactedResponseText);
    const detail = parsed.message ?? (redactedResponseText || "unknown");
    super(`Twilio SMS ${operation} failed (${httpStatus}): ${detail}`);
    this.name = "TwilioSmsApiError";
    this.httpStatus = httpStatus;
    this.responseText = redactedResponseText;
    this.twilioCode = parsed.code;
  }
}

function parseTwilioFormBody(body: string): Record<string, string> {
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

export function verifyTwilioSignature(params: {
  signature: string | undefined;
  url: string;
  authToken: string;
  form: Record<string, string>;
}): boolean {
  if (!params.signature || !params.url || !params.authToken) {
    return false;
  }
  return safeEqualSecret(
    params.signature,
    computeTwilioSignature({
      url: params.url,
      authToken: params.authToken,
      form: params.form,
    }),
  );
}

function parseTwilioInboundFrom(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const channelAddress = trimmed.match(TWILIO_CHANNEL_ADDRESS_RE);
  const kind = channelAddress?.[1]?.toLowerCase();
  if (kind && kind !== "rcs") {
    return null;
  }
  const phoneNumber = normalizeSmsPhoneNumber(channelAddress?.[2] ?? trimmed);
  if (!looksLikeSmsPhoneNumber(phoneNumber)) {
    return null;
  }
  return phoneNumber;
}

export function resolveTwilioInboundSender(form: Record<string, string>): string {
  return parseTwilioInboundFrom(firstTrimmedString(form.From)) ?? "";
}

export function buildTwilioInboundMessage(form: Record<string, string>): SmsInboundMessage | null {
  // Signature verification owns the untouched form. Canonicalize only after
  // that boundary so Twilio channel prefixes never change its signed input.
  const from = resolveTwilioInboundSender(form);
  const to = firstTrimmedString(form.To);
  const body = firstString(form.Body);
  const accountSid = firstString(form.AccountSid);
  const messagingServiceSid = firstString(form.MessagingServiceSid);
  const messageSid = resolveTwilioMessageSid(form);
  const rawMediaCount = firstTrimmedString(form.NumMedia);
  const mediaCount = rawMediaCount ? Number(rawMediaCount) : 0;
  if (!Number.isSafeInteger(mediaCount) || mediaCount < 0) {
    return null;
  }
  let unavailableMediaCount = Math.max(0, mediaCount - SMS_MAX_INBOUND_MEDIA_DOWNLOADS);
  const media = Array.from(
    { length: Math.min(mediaCount, SMS_MAX_INBOUND_MEDIA_DOWNLOADS) },
    (_value, index) => {
      const url = firstTrimmedString(form[`MediaUrl${index}`]);
      const contentType = firstTrimmedString(form[`MediaContentType${index}`]);
      if (!url) {
        unavailableMediaCount += 1;
        return null;
      }
      return {
        url,
        ...(contentType ? { contentType } : {}),
      };
    },
  ).filter((item): item is NonNullable<typeof item> => item !== null);
  if (!from || !to || (!body && mediaCount === 0) || !messageSid) {
    return null;
  }
  return {
    accountSid,
    from,
    to,
    body,
    messageSid,
    media,
    ...(messagingServiceSid ? { messagingServiceSid } : {}),
    ...(unavailableMediaCount > 0 ? { unavailableMediaCount } : {}),
  };
}

export function resolveTwilioMessageSid(form: Record<string, string>): string {
  return (
    firstTrimmedString(form.MessageSid) ||
    firstTrimmedString(form.SmsSid) ||
    firstTrimmedString(form.SmsMessageSid)
  );
}

export async function readTwilioWebhookForm(req: IncomingMessage): Promise<Record<string, string>> {
  const body = await readRequestBodyWithLimit(req, {
    maxBytes: WEBHOOK_BODY_LIMIT_BYTES,
    timeoutMs: WEBHOOK_BODY_TIMEOUT_MS,
    // Defer destruction so the webhook can answer 413 before the connection closes.
    destroyOnLimit: false,
  });
  return parseTwilioFormBody(body);
}

export const TWIML_CONTENT_TYPE = "text/xml; charset=utf-8";

export function respondTwiml(res: ServerResponse, statusCode: number, body = ""): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", TWIML_CONTENT_TYPE);
  res.end(body || "<Response></Response>");
}

function basicAuthHeader(account: ResolvedSmsAccount): string {
  return `Basic ${Buffer.from(`${account.accountSid}:${account.authToken}`).toString("base64")}`;
}

function appendTruncatedResponseSuffix(text: string): string {
  return `${text.trimEnd()}${TRUNCATED_RESPONSE_SUFFIX}`;
}

async function readTwilioApiResponseText(response: Response): Promise<string> {
  const maxBytes = response.ok
    ? TWILIO_API_SUCCESS_BODY_LIMIT_BYTES
    : TWILIO_API_ERROR_BODY_LIMIT_BYTES;
  if (!response.ok) {
    const prefix = await readResponseTextPrefix(response, maxBytes);
    return prefix.truncated ? appendTruncatedResponseSuffix(prefix.text) : prefix.text;
  }

  const body = await readResponseWithLimit(response, maxBytes, {
    onOverflow: ({ size, maxBytes: limit }) =>
      new Error(`Twilio SMS API response body too large: ${size} bytes (limit: ${limit} bytes)`),
  });
  return new TextDecoder().decode(body);
}

function assertTwilioRequestCredentialsAvailable(account: ResolvedSmsAccount): void {
  try {
    assertSmsCredentialOwnerAvailable(account);
  } catch (error) {
    throw new PlatformMessageNotDispatchedError(
      `SMS request stopped before Twilio dispatch: ${formatErrorMessage(error)}`,
      { cause: error },
    );
  }
}

async function requestTwilioApi(params: {
  path: string;
  api: "accounts" | "messaging";
  query?: URLSearchParams;
  operation?: string;
  account: ResolvedSmsAccount;
  init?: Omit<RequestInit, "headers"> & { headers?: Record<string, string> };
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<string> {
  const baseUrl =
    params.api === "accounts"
      ? `${TWILIO_ACCOUNTS_URL}/${encodeURIComponent(params.account.accountSid)}`
      : TWILIO_MESSAGING_URL;
  const url = new URL(`${baseUrl}${params.path}`);
  if (params.query) {
    url.search = params.query.toString();
  }
  const init = {
    ...params.init,
    headers: {
      ...params.init?.headers,
      authorization: basicAuthHeader(params.account),
    },
  } satisfies RequestInit;
  let response: Response;
  let release: (() => Promise<void>) | undefined;
  const fetchImpl = params.fetchImpl;
  if (fetchImpl) {
    response = await captureEffectAuthority().initiate(() => {
      assertTwilioRequestCredentialsAvailable(params.account);
      return fetchImpl(url.toString(), init);
    });
  } else {
    let requestDispatched = false;
    ({ response, release } = await fetchWithSsrFGuard({
      url: url.toString(),
      init,
      beforeRequest: () => {
        if (requestDispatched) {
          assertSmsCredentialOwnerAvailable(params.account);
          return;
        }
        assertTwilioRequestCredentialsAvailable(params.account);
        // A later callback means the preceding request returned a redirect response.
        requestDispatched = true;
      },
      auditContext: "sms-twilio-api",
      policy: {
        allowedHostnames: [
          params.api === "accounts" ? TWILIO_API_HOSTNAME : TWILIO_MESSAGING_HOSTNAME,
        ],
      },
      requireHttps: true,
      timeoutMs: params.timeoutMs ?? TWILIO_API_TIMEOUT_MS,
    }));
  }
  let ok: boolean;
  let status: number;
  let text: string;
  try {
    ({ ok, status } = response);
    text = await readTwilioApiResponseText(response);
  } finally {
    if (release) {
      await release();
    }
  }
  if (!ok) {
    throw new TwilioSmsApiError(status, text, params.operation);
  }
  return text;
}

function parseTwilioIncomingPhoneNumber(record: Record<string, unknown>) {
  return {
    sid: firstTrimmedString(record.sid),
    phoneNumber: firstTrimmedString(record.phone_number ?? record.phoneNumber),
    smsUrl: firstTrimmedString(record.sms_url ?? record.smsUrl),
    smsMethod: firstTrimmedString(record.sms_method ?? record.smsMethod),
    voiceUrl: firstTrimmedString(record.voice_url ?? record.voiceUrl),
  };
}

function parseTwilioMessageLogEntry(record: Record<string, unknown>) {
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

function parseTwilioMessagingService(record: Record<string, unknown>) {
  return {
    sid: firstTrimmedString(record.sid),
    inboundRequestUrl: firstTrimmedString(record.inbound_request_url ?? record.inboundRequestUrl),
    inboundMethod: firstTrimmedString(record.inbound_method ?? record.inboundMethod),
    useInboundWebhookOnNumber: Boolean(
      record.use_inbound_webhook_on_number ?? record.useInboundWebhookOnNumber,
    ),
  };
}

function parseTwilioListPayload<T>(
  text: string,
  key: string,
  parseEntry: (record: Record<string, unknown>) => T,
): T[] {
  const items = asNullableObjectRecord(safeParseJson<unknown>(text))?.[key];
  if (!Array.isArray(items)) {
    return [];
  }
  return items.filter(isRecord).map(parseEntry);
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
  const text = await requestTwilioApi({
    account: params.account,
    path: "/IncomingPhoneNumbers.json",
    api: "accounts",
    query,
    operation: "phone-number lookup",
    fetchImpl: params.fetchImpl,
    timeoutMs: params.timeoutMs,
  });
  return parseTwilioListPayload(text, "incoming_phone_numbers", parseTwilioIncomingPhoneNumber);
}

export async function retrieveTwilioMessagingService(params: {
  account: ResolvedSmsAccount;
  serviceSid: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<TwilioMessagingService> {
  const text = await requestTwilioApi({
    account: params.account,
    path: `/Services/${encodeURIComponent(params.serviceSid)}`,
    api: "messaging",
    operation: "messaging-service lookup",
    fetchImpl: params.fetchImpl,
    timeoutMs: params.timeoutMs,
  });
  const parsed = safeParseJson<unknown>(text);
  if (!isRecord(parsed)) {
    throw new Error("Twilio Messaging Service lookup returned malformed JSON.");
  }
  return parseTwilioMessagingService(parsed);
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
  const text = await requestTwilioApi({
    account: params.account,
    path: "/Messages.json",
    api: "accounts",
    query,
    operation: "message lookup",
    fetchImpl: params.fetchImpl,
    timeoutMs: params.timeoutMs,
  });
  return parseTwilioListPayload(text, "messages", parseTwilioMessageLogEntry);
}

export async function sendSmsViaTwilio(params: {
  account: ResolvedSmsAccount;
  to: string;
  text?: string;
  mediaUrls?: readonly string[];
  fetchImpl?: typeof fetch;
  onPlatformSendDispatch?: () => Promise<void>;
}): Promise<SmsSendResult> {
  assertSmsCredentialOwnerAvailable(params.account);
  if (!params.account.fromNumber && !params.account.messagingServiceSid) {
    throw new Error("Twilio SMS send requires fromNumber or messagingServiceSid.");
  }
  if (params.text && params.text.length > TWILIO_MESSAGE_BODY_MAX_LENGTH) {
    throw new Error(
      `Twilio SMS/MMS Body supports at most ${TWILIO_MESSAGE_BODY_MAX_LENGTH} characters.`,
    );
  }
  const mediaUrls = (params.mediaUrls ?? []).map((url) => url.trim()).filter(Boolean);
  if (!params.text && mediaUrls.length === 0) {
    throw new Error("Twilio SMS/MMS send requires text or media.");
  }
  if (mediaUrls.length > TWILIO_MMS_MAX_OUTBOUND_MEDIA_COUNT) {
    throw new Error(
      `Twilio MMS send supports at most ${TWILIO_MMS_MAX_OUTBOUND_MEDIA_COUNT} media URLs.`,
    );
  }
  const body = new URLSearchParams({ To: params.to });
  if (params.text) {
    body.set("Body", params.text);
  }
  for (const mediaUrl of mediaUrls) {
    body.append("MediaUrl", mediaUrl);
  }
  if (params.account.fromNumber) {
    body.set("From", params.account.fromNumber);
  } else {
    body.set("MessagingServiceSid", params.account.messagingServiceSid);
  }
  const statusCallback = resolveTwilioStatusCallbackUrl(params.account.publicWebhookUrl);
  if (statusCallback) {
    body.set("StatusCallback", statusCallback);
  }
  const init = {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  } satisfies RequestInit;
  await params.onPlatformSendDispatch?.();
  const text = await requestTwilioApi({
    account: params.account,
    path: "/Messages.json",
    api: "accounts",
    init,
    fetchImpl: params.fetchImpl,
  });
  const payload = parseTwilioSuccessPayload(text);
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
