// Sms test support shares webhook fixtures between the unit and raw-wire suites.
import { createHmac } from "node:crypto";
import { vi } from "vitest";
import type { SmsDeliveryRecorder } from "./delivery-observations.js";
import type { ResolvedSmsAccount } from "./types.js";

let testAccountSequence = 0;
let activeAccountId = "test-0";

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
    fromNumber: "+15557654321",
    messagingServiceSid: "",
    defaultTo: "",
    webhookPath: "/webhooks/sms",
    publicWebhookUrl: "https://gateway.example.com/webhooks/sms",
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
