import { describe, expect, it } from "vitest";
import {
  detectMessageDeliveryReceiptClaim,
  detectMessageDeliveryReceiptClaims,
} from "./message-delivery-receipt-claims.js";

describe("message delivery receipt claims", () => {
  it("detects the incident-style SMS receipt", () => {
    expect(
      detectMessageDeliveryReceiptClaim(`Sent to Jiva. To: +13522815065
From: Sales +14155201316
Status: accepted/queued
Message ID: 6655442331193344`),
    ).toMatchObject({
      channel: "sms",
      recipient: "+13522815065",
      status: "accepted/queued",
      providerId: "6655442331193344",
    });
  });

  it("detects short SMS message-id receipts", () => {
    expect(
      detectMessageDeliveryReceiptClaim("SMS sent, message ID 4797682962735104"),
    ).toMatchObject({
      channel: "sms",
      providerId: "4797682962735104",
    });
  });

  it("detects accepted/queued SMS receipt starts", () => {
    expect(
      detectMessageDeliveryReceiptClaim("SMS was accepted/queued. Message ID: 4797682962735104"),
    ).toMatchObject({
      channel: "sms",
      providerId: "4797682962735104",
    });
  });

  it("detects first-person SMS receipts with status and message id", () => {
    expect(
      detectMessageDeliveryReceiptClaim(
        "I sent the SMS. Status: accepted/queued. Message ID: 4797682962735104",
      ),
    ).toMatchObject({
      channel: "sms",
      status: "accepted/queued",
      providerId: "4797682962735104",
    });
  });

  it("detects first-person SMS receipts with an article", () => {
    expect(
      detectMessageDeliveryReceiptClaim(
        "I sent an SMS. Status: accepted/queued. Message ID: 4797682962735104",
      ),
    ).toMatchObject({
      channel: "sms",
      status: "accepted/queued",
      providerId: "4797682962735104",
    });
  });

  it("detects recipients in natural SMS-to-phone receipt wording", () => {
    expect(
      detectMessageDeliveryReceiptClaim(
        "I sent the SMS to +15550009999. Status: accepted/queued. Message ID: SM1001",
      ),
    ).toMatchObject({
      channel: "sms",
      recipient: "+15550009999",
      status: "accepted/queued",
      providerId: "SM1001",
    });
  });

  it("detects first-person SMS sent assertions without receipt fields", () => {
    expect(detectMessageDeliveryReceiptClaim("I sent the SMS.")).toMatchObject({
      channel: "sms",
    });
  });

  it("detects SMS sent assertions even when later text mentions a draft", () => {
    expect(detectMessageDeliveryReceiptClaim("I sent the SMS. Draft text: thanks.")).toMatchObject({
      channel: "sms",
    });
  });

  it("detects sent-before-text-message assertions without receipt fields", () => {
    expect(detectMessageDeliveryReceiptClaim("Sent the text message.")).toMatchObject({
      channel: "sms",
    });
  });

  it("detects sent-to phone receipts without a colon", () => {
    expect(detectMessageDeliveryReceiptClaim("SMS sent to +15550009999")).toMatchObject({
      channel: "sms",
      recipient: "+15550009999",
    });
  });

  it("ignores generic non-SMS message confirmations", () => {
    expect(detectMessageDeliveryReceiptClaim("The Telegram message was sent.")).toBeNull();
  });

  it("ignores drafts and explicit uncertainty", () => {
    expect(
      detectMessageDeliveryReceiptClaim("Here is the draft to send: thanks for your time."),
    ).toBeNull();
    expect(
      detectMessageDeliveryReceiptClaim("I do not see evidence that it was sent. Check Dialpad."),
    ).toBeNull();
  });

  it("ignores negated SMS sent statements before the delivery verb", () => {
    expect(detectMessageDeliveryReceiptClaim("I have not sent the SMS yet.")).toBeNull();
    expect(detectMessageDeliveryReceiptClaim("I haven't sent the SMS yet.")).toBeNull();
    expect(detectMessageDeliveryReceiptClaim("I have not yet sent the SMS.")).toBeNull();
  });

  it("ignores quoted diagnostic receipt text", () => {
    expect(
      detectMessageDeliveryReceiptClaim(
        "> Sent to Jiva. Status: accepted/queued. Message ID: fake",
      ),
    ).toBeNull();
  });

  it("detects every SMS receipt claim in a response", () => {
    expect(
      detectMessageDeliveryReceiptClaims(`Sent to Jiva. To: +13522815065
Status: accepted/queued
Message ID: 4797682962735104

Sent to Sunny. To: +15550009999
Status: accepted/queued
Message ID: 9999`),
    ).toEqual([
      expect.objectContaining({
        recipient: "+13522815065",
        providerId: "4797682962735104",
      }),
      expect.objectContaining({
        recipient: "+15550009999",
        providerId: "9999",
      }),
    ]);
  });

  it("ignores explanatory SMS field documentation", () => {
    expect(
      detectMessageDeliveryReceiptClaim(
        "For SMS, Status: accepted/queued and Message ID: 4797682962735104 mean the provider queued it.",
      ),
    ).toBeNull();
  });

  it("ignores non-SMS sent-to receipts", () => {
    expect(
      detectMessageDeliveryReceiptClaim(`Sent to Bob. To: bob@example.com
Status: sent
Message ID: abcd1234`),
    ).toBeNull();
  });
});
