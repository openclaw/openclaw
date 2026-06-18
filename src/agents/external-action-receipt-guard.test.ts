import { describe, expect, it } from "vitest";
import { guardExternalActionReceiptText } from "./external-action-receipt-guard.js";

describe("external action receipt guard", () => {
  const receiptText = `Sent to Jiva. To: +13522815065
From: +14155201316
Status: accepted/queued
Message ID: 4797682962735104`;

  it("blocks receipt text without matching current-turn evidence", () => {
    expect(guardExternalActionReceiptText({ text: receiptText })).toMatchObject({
      allowed: false,
      replacementText: expect.stringContaining("cannot verify"),
    });
  });

  it("blocks mismatched provider ids", () => {
    expect(
      guardExternalActionReceiptText({
        text: receiptText,
        evidence: [
          {
            actionFamily: "sms",
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
      guardExternalActionReceiptText({
        text: receiptText,
        evidence: [
          {
            actionFamily: "sms",
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
      guardExternalActionReceiptText({
        text: "SMS sent.",
        evidence: [
          {
            actionFamily: "sms",
            providerId: "4797682962735104",
            status: "accepted/queued",
          },
        ],
      }),
    ).toMatchObject({ allowed: false });
  });

  it("blocks mismatched sent-to phone claims", () => {
    expect(
      guardExternalActionReceiptText({
        text: "SMS sent to +15550009999",
        evidence: [
          {
            actionFamily: "sms",
            providerId: "4797682962735104",
            status: "accepted/queued",
            recipient: "+15550001111",
          },
        ],
      }),
    ).toMatchObject({ allowed: false });
  });

  it("allows matching evidence", () => {
    expect(
      guardExternalActionReceiptText({
        text: receiptText,
        evidence: [
          {
            actionFamily: "sms",
            providerId: "4797682962735104",
            status: "accepted/queued",
            recipient: "+13522815065",
            sender: "+14155201316",
          },
        ],
      }),
    ).toEqual({ allowed: true });
  });

  it("blocks when one of multiple receipt claims lacks matching evidence", () => {
    expect(
      guardExternalActionReceiptText({
        text: `${receiptText}

Sent to Sunny. To: +15550009999
Status: accepted/queued
Message ID: 9999`,
        evidence: [
          {
            actionFamily: "sms",
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
      guardExternalActionReceiptText({
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
      guardExternalActionReceiptText({
        text: "For SMS, Status: accepted/queued and Message ID: 4797682962735104 mean the provider queued it.",
      }),
    ).toEqual({ allowed: true });
  });

  it("allows matching phone evidence with provider formatting punctuation", () => {
    expect(
      guardExternalActionReceiptText({
        text: receiptText,
        evidence: [
          {
            actionFamily: "sms",
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
      guardExternalActionReceiptText({
        text: `Sent to Jiva. To: 352-281-5065
From: 415-520-1316
Status: accepted/queued
Message ID: 4797682962735104`,
        evidence: [
          {
            actionFamily: "sms",
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
      guardExternalActionReceiptText({
        text: "Draft: Thanks Jiva. You can book a demo here.",
      }),
    ).toEqual({ allowed: true });
  });
});
