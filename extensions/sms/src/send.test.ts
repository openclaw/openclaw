import { describe, expect, it, vi } from "vitest";
import { sendSmsTextChunks } from "./send.js";
import type { ResolvedSmsAccount } from "./types.js";

const sendSmsViaTwilio = vi.hoisted(() => vi.fn(async ({ to }) => ({ sid: `SM-${to}`, to })));

vi.mock("./twilio.js", () => ({
  sendSmsViaTwilio,
}));

function createAccount(textChunkLimit: number): ResolvedSmsAccount {
  return {
    accountId: "default",
    enabled: true,
    accountSid: "AC123",
    authToken: "secret",
    fromNumber: "+15557654321",
    webhookPath: "/webhooks/sms",
    publicWebhookUrl: "https://gateway.example.com/webhooks/sms",
    dangerouslyDisableSignatureValidation: false,
    dmPolicy: "pairing",
    allowFrom: [],
    textChunkLimit,
  };
}

describe("sendSmsTextChunks", () => {
  it("splits long SMS text before sending to Twilio", async () => {
    await sendSmsTextChunks({
      account: createAccount(5),
      to: "+15551234567",
      text: "alpha beta",
    });

    expect(sendSmsViaTwilio).toHaveBeenCalledTimes(2);
    expect(sendSmsViaTwilio.mock.calls.map(([call]) => call.text)).toEqual(["alpha", "beta"]);
  });
});
