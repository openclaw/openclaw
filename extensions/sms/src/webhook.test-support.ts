// Sms test support shares webhook fixtures between the unit and raw-wire suites.
import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { Readable } from "node:stream";
import { vi } from "vitest";
import type { SmsDeliveryRecorder } from "./delivery-observations.js";
import type { ResolvedSmsAccount } from "./types.js";

let testAccountSequence = 0;
let activeAccountId = "test-0";
export const SMS_TEST_WEBHOOK = "https://gateway.example.com/webhooks/sms";
export const SMS_TEST_FROM = "+15557654321";
export const SMS_TEST_TO = "+15551234567";

// Each test gets its own account id so the handler's per-account rate-limiter
// buckets never carry a previous test's counters into the next one.
export function advanceSmsTestAccountId(): string {
  activeAccountId = `test-${++testAccountSequence}`;
  return activeAccountId;
}

export function createSmsTestAccount(
  overrides: Partial<ResolvedSmsAccount> = {},
): ResolvedSmsAccount {
  return {
    accountId: activeAccountId,
    enabled: true,
    accountSid: "AC123",
    authToken: "secret",
    fromNumber: SMS_TEST_FROM,
    messagingServiceSid: "",
    defaultTo: "",
    webhookPath: "/webhooks/sms",
    publicWebhookUrl: SMS_TEST_WEBHOOK,
    dangerouslyDisableSignatureValidation: false,
    dmPolicy: "pairing",
    allowFrom: [],
    textChunkLimit: 1500,
    ...overrides,
  };
}

export function createSmsTestDeliveryRecorder(
  record = vi.fn<SmsDeliveryRecorder["record"]>(async ({ account, form }) => ({
    duplicate: false,
    record: {
      accountId: account.accountId,
      accountSidHash: "account-sid-hash",
      messageSid: form.MessageSid ?? form.SmsSid ?? form.SmsMessageSid ?? "",
      status: form.MessageStatus ?? form.SmsStatus ?? "",
      firstObservedAt: 1,
      lastObservedAt: 1,
      observations: [],
    },
  })),
): SmsDeliveryRecorder & { record: typeof record } {
  return { record };
}

// Raw provider input shared by webhook and transport tests, never normalized by production code.
export function createSmsTestForm(
  overrides: Record<string, string> = {},
  account = createSmsTestAccount(),
): Record<string, string> {
  return {
    AccountSid: account.accountSid,
    From: "+15551234567",
    To: account.fromNumber,
    Body: "hello",
    MessageSid: "SM123",
    ...overrides,
  };
}

export function signSmsTestForm(form: Record<string, string>, account = createSmsTestAccount()) {
  const signed =
    account.publicWebhookUrl +
    Object.keys(form)
      .toSorted()
      .map((key) => `${key}${form[key] ?? ""}`)
      .join("");
  return {
    body: new URLSearchParams(form).toString(),
    signature: createHmac("sha1", account.authToken).update(signed).digest("base64"),
  };
}

export function createSmsTestRequest(
  { body, signature }: { body: string; signature: string },
  options: { headers?: Record<string, string>; remoteAddress?: string } = {},
): IncomingMessage {
  const req = Readable.from([body]) as IncomingMessage;
  req.method = "POST";
  req.headers = {
    "content-length": String(Buffer.byteLength(body)),
    "x-twilio-signature": signature,
    ...options.headers,
  };
  const socket = new Socket();
  Object.defineProperty(socket, "remoteAddress", { value: options.remoteAddress ?? "127.0.0.1" });
  Object.defineProperty(req, "socket", { value: socket });
  return req;
}

export function createSmsTestResponse() {
  const setHeader = vi.fn();
  const end = vi.fn();
  return {
    statusCode: 200,
    setHeader,
    end,
    setHeaderMock: setHeader,
    endMock: end,
  } as unknown as ServerResponse & { setHeaderMock: typeof setHeader; endMock: typeof end };
}

export function createSmsTestPhoneNumber(overrides: Record<string, unknown> = {}) {
  return {
    phone_number: SMS_TEST_FROM,
    sms_url: SMS_TEST_WEBHOOK,
    sms_method: "POST",
    ...overrides,
  };
}

export function createSmsTestMessage(overrides: Record<string, unknown> = {}) {
  return {
    sid: "SM123",
    direction: "inbound",
    status: "received",
    to: SMS_TEST_FROM,
    from: SMS_TEST_TO,
    ...overrides,
  };
}
