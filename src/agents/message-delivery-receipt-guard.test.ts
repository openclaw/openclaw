import { describe, expect, it } from "vitest";
import { guardMessageDeliveryReceiptText } from "./message-delivery-receipt-guard.js";
import { guardMessageDeliveryReceiptStreamData } from "./message-delivery-receipt-stream.js";

describe("message delivery receipt guard", () => {
  const receiptText = `Sent to Jiva. To: +13522815065
From: +14155201316
Status: accepted/queued
Message ID: 4797682962735104`;

  it("blocks receipt text without matching current-turn evidence", () => {
    expect(guardMessageDeliveryReceiptText({ text: receiptText })).toMatchObject({
      allowed: false,
      replacementText: expect.stringContaining("cannot verify"),
    });
  });

  it("blocks mismatched provider ids", () => {
    expect(
      guardMessageDeliveryReceiptText({
        text: receiptText,
        evidence: [
          {
            channel: "sms",
            providerId: "different",
            status: "accepted/queued",
            recipient: "+13522815065",
            sender: "+14155201316",
          },
        ],
      }),
    ).toMatchObject({ allowed: false });
  });

  it("blocks status claims when evidence has no matching status", () => {
    expect(
      guardMessageDeliveryReceiptText({
        text: receiptText,
        evidence: [
          {
            channel: "sms",
            providerId: "4797682962735104",
            recipient: "+13522815065",
            sender: "+14155201316",
          },
        ],
      }),
    ).toMatchObject({ allowed: false });
  });

  it("blocks ambiguous claims even when current-turn SMS evidence exists", () => {
    expect(
      guardMessageDeliveryReceiptText({
        text: "SMS sent.",
        evidence: [
          {
            channel: "sms",
            providerId: "4797682962735104",
            status: "accepted/queued",
          },
        ],
      }),
    ).toMatchObject({ allowed: false });
  });

  it("blocks first-person SMS sent claims without receipt fields", () => {
    expect(guardMessageDeliveryReceiptText({ text: "I sent the SMS." })).toMatchObject({
      allowed: false,
    });
  });

  it("blocks mismatched sent-to phone claims", () => {
    expect(
      guardMessageDeliveryReceiptText({
        text: "SMS sent to +15550009999",
        evidence: [
          {
            channel: "sms",
            providerId: "4797682962735104",
            status: "accepted/queued",
            recipient: "+15550001111",
          },
        ],
      }),
    ).toMatchObject({ allowed: false });
  });

  it("blocks natural SMS-to-phone claims when the recipient mismatches evidence", () => {
    expect(
      guardMessageDeliveryReceiptText({
        text: "I sent the SMS to +15550009999. Message ID: SM1001",
        evidence: [
          {
            channel: "sms",
            providerId: "SM1001",
            status: "accepted/queued",
            recipient: "+15550001111",
          },
        ],
      }),
    ).toMatchObject({ allowed: false });
  });

  it("allows matching evidence", () => {
    expect(
      guardMessageDeliveryReceiptText({
        text: receiptText,
        evidence: [
          {
            channel: "sms",
            providerId: "4797682962735104",
            status: "accepted/queued",
            recipient: "+13522815065",
            sender: "+14155201316",
          },
        ],
      }),
    ).toEqual({ allowed: true });
  });

  it("allows built-in message evidence with queued status for accepted/queued receipt text", () => {
    expect(
      guardMessageDeliveryReceiptText({
        text: "I sent the SMS. Status: accepted/queued. Message ID: SM-default",
        evidence: [
          {
            channel: "sms",
            toolName: "message",
            providerId: "SM-default",
            status: "queued",
          },
        ],
      }),
    ).toEqual({ allowed: true });
  });

  it("blocks when one of multiple receipt claims lacks matching evidence", () => {
    expect(
      guardMessageDeliveryReceiptText({
        text: `${receiptText}

Sent to Sunny. To: +15550009999
Status: accepted/queued
Message ID: 9999`,
        evidence: [
          {
            channel: "sms",
            providerId: "4797682962735104",
            status: "accepted/queued",
            recipient: "+13522815065",
            sender: "+14155201316",
          },
        ],
      }),
    ).toMatchObject({
      allowed: false,
      claim: expect.objectContaining({ providerId: "9999", recipient: "+15550009999" }),
    });
  });

  it("blocks unsupported receipt claims after a long answer prefix", () => {
    expect(
      guardMessageDeliveryReceiptText({
        text: `${"context ".repeat(1_200)}
Sent to Jiva. To: +13522815065
Status: accepted/queued
Message ID: 4797682962735104`,
      }),
    ).toMatchObject({
      allowed: false,
      claim: expect.objectContaining({ providerId: "4797682962735104" }),
    });
  });

  it("allows explanatory SMS field text", () => {
    expect(
      guardMessageDeliveryReceiptText({
        text: "For SMS, Status: accepted/queued and Message ID: 4797682962735104 mean the provider queued it.",
      }),
    ).toEqual({ allowed: true });
  });

  it("allows explicit non-delivery SMS statements", () => {
    expect(
      guardMessageDeliveryReceiptText({
        text: "I have not sent the SMS yet.",
      }),
    ).toEqual({ allowed: true });
    expect(
      guardMessageDeliveryReceiptText({
        text: "I haven't sent the SMS yet.",
      }),
    ).toEqual({ allowed: true });
  });

  it("allows matching phone evidence with provider formatting punctuation", () => {
    expect(
      guardMessageDeliveryReceiptText({
        text: receiptText,
        evidence: [
          {
            channel: "sms",
            providerId: "4797682962735104",
            status: "accepted/queued",
            recipient: "+1 (352) 281-5065",
            sender: "+1 415 520 1316",
          },
        ],
      }),
    ).toEqual({ allowed: true });
  });

  it("allows matching US local phone claims against E.164 provider evidence", () => {
    expect(
      guardMessageDeliveryReceiptText({
        text: `Sent to Jiva. To: 352-281-5065
From: 415-520-1316
Status: accepted/queued
Message ID: 4797682962735104`,
        evidence: [
          {
            channel: "sms",
            providerId: "4797682962735104",
            status: "accepted/queued",
            recipient: "+13522815065",
            sender: "+14155201316",
          },
        ],
      }),
    ).toEqual({ allowed: true });
  });

  it("allows non-receipt drafting text", () => {
    expect(
      guardMessageDeliveryReceiptText({
        text: "Draft: Thanks Jiva. You can book a demo here.",
      }),
    ).toEqual({ allowed: true });
  });

  it("preserves stream media when replacing unsupported receipt claims", () => {
    expect(
      guardMessageDeliveryReceiptStreamData({
        enabled: true,
        data: {
          text: "I sent the SMS. Status: accepted/queued. Message ID: SM-unverified",
          delta: "I sent the SMS. Status: accepted/queued. Message ID: SM-unverified",
          mediaUrls: ["https://example.com/proof.png"],
        },
      }),
    ).toMatchObject({
      text: expect.stringContaining("cannot verify"),
      delta: expect.stringContaining("cannot verify"),
      replace: true,
      mediaUrls: ["https://example.com/proof.png"],
    });
  });
});
