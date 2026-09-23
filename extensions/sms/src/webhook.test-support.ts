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

export function computeSmsTestTwilioSignature(params: {
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

export function createSignedDeliveryPayload(params: {
  messageSid: string;
  status: string;
  account?: ResolvedSmsAccount;
  accountSid?: string;
}): { body: string; signature: string; form: Record<string, string> } {
  const account = params.account ?? createSmsTestAccount();
  const form = {
    AccountSid: params.accountSid ?? account.accountSid,
    From: account.fromNumber,
    To: "+15551234567",
    MessageSid: params.messageSid,
    MessageStatus: params.status,
  };
  const body = new URLSearchParams(form).toString();
  return {
    body,
    form,
    signature: computeSmsTestTwilioSignature({
      url: account.publicWebhookUrl,
      authToken: account.authToken,
      form,
    }),
  };
}
