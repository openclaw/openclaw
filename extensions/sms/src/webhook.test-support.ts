import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { Readable } from "node:stream";
import { vi } from "vitest";
import type { SmsDeliveryRecorder } from "./delivery-observations.js";
import type { ResolvedSmsAccount as Account } from "./types.js";

type Form = Record<string, string>;

let testAccountSequence = 0;
const SMS_TEST_WEBHOOK = "https://gateway.example.com/webhooks/sms";
const SMS_TEST_FROM = "+15557654321";
const SMS_TEST_TO = "+15551234567";

// Separate account IDs keep rate-limiter buckets isolated between tests.
export const advanceSmsTestAccountId = (): string => `test-${++testAccountSequence}`;

export const createSmsTestAccount = (overrides: Partial<Account> = {}): Account => ({
  accountId: `test-${testAccountSequence}`,
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
});

export const createSmsTestDeliveryRecorder = (
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
): SmsDeliveryRecorder & { record: typeof record } => ({ record });

// Raw provider input shared by webhook and transport tests, never normalized by production code.
export const createSmsTestForm = (fields: Form = {}, account = createSmsTestAccount()): Form => ({
  AccountSid: account.accountSid,
  From: "+15551234567",
  To: account.fromNumber,
  Body: "hello",
  MessageSid: "SM123",
  ...fields,
});

export function signSmsTestForm(form: Form, account = createSmsTestAccount()) {
  const signed = Object.keys(form)
    .toSorted()
    .reduce((text, key) => text + key + (form[key] ?? ""), account.publicWebhookUrl);
  return {
    body: new URLSearchParams(form).toString(),
    signature: createHmac("sha1", account.authToken).update(signed).digest("base64"),
  };
}

export function createSmsTestRequest(
  { body, signature }: { body: string; signature: string },
  options: { headers?: Form; remoteAddress?: string } = {},
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

export const createSmsTestPhoneNumber = (overrides: Record<string, unknown> = {}) => ({
  phone_number: SMS_TEST_FROM,
  sms_url: SMS_TEST_WEBHOOK,
  sms_method: "POST",
  ...overrides,
});

export const createSmsTestMessage = (overrides: Record<string, unknown> = {}) => ({
  sid: "SM123",
  direction: "inbound",
  status: "received",
  to: SMS_TEST_FROM,
  from: SMS_TEST_TO,
  ...overrides,
});
