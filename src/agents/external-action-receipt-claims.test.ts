import { describe, expect, it } from "vitest";
import {
  detectExternalActionReceiptClaim,
  detectExternalActionReceiptClaims,
} from "./external-action-receipt-claims.js";

describe("external action receipt claims", () => {
  it("detects the incident-style SMS receipt", () => {
    expect(
      detectExternalActionReceiptClaim(`Sent to Jiva. To: +13522815065
From: Sales +14155201316
Status: accepted/queued
Message ID: 6655442331193344`),
    ).toMatchObject({
      actionFamily: "sms",
      recipient: "+13522815065",
      status: "accepted/queued",
      providerId: "6655442331193344",
    });
  });

  it("detects short SMS message-id receipts", () => {
    expect(detectExternalActionReceiptClaim("SMS sent, message ID 4797682962735104")).toMatchObject(
      {
        actionFamily: "sms",
        providerId: "4797682962735104",
      },
    );
  });

  it("detects sent-to phone receipts without a colon", () => {
    expect(detectExternalActionReceiptClaim("SMS sent to +15550009999")).toMatchObject({
      actionFamily: "sms",
      recipient: "+15550009999",
    });
  });

  it("ignores generic non-SMS message confirmations", () => {
    expect(detectExternalActionReceiptClaim("The Telegram message was sent.")).toBeNull();
  });

  it("ignores drafts and explicit uncertainty", () => {
    expect(
      detectExternalActionReceiptClaim("Here is the draft to send: thanks for your time."),
    ).toBeNull();
    expect(
      detectExternalActionReceiptClaim("I do not see evidence that it was sent. Check Dialpad."),
    ).toBeNull();
  });

  it("ignores quoted diagnostic receipt text", () => {
    expect(
      detectExternalActionReceiptClaim("> Sent to Jiva. Status: accepted/queued. Message ID: fake"),
    ).toBeNull();
  });

  it("detects every SMS receipt claim in a response", () => {
    expect(
      detectExternalActionReceiptClaims(`Sent to Jiva. To: +13522815065
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
      detectExternalActionReceiptClaim(
        "For SMS, Status: accepted/queued and Message ID: 4797682962735104 mean the provider queued it.",
      ),
    ).toBeNull();
  });

  it("ignores non-SMS sent-to receipts", () => {
    expect(
      detectExternalActionReceiptClaim(`Sent to Bob. To: bob@example.com
Status: sent
Message ID: abcd1234`),
    ).toBeNull();
  });
});
