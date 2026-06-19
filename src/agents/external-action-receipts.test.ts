import { describe, expect, it } from "vitest";
import {
  isValidExternalActionEvidenceDeclaration,
  normalizeMessageToolExternalActionEvidence,
  normalizeExternalActionEvidence,
} from "./external-action-receipts.js";

const smsDeclaration = {
  actionFamily: "sms",
  successStatusPaths: ["status", "delivery.status"],
  providerIdPaths: ["id", "messageId"],
  senderPaths: ["from"],
  recipientPaths: ["to"],
  bodyPaths: ["message"],
  dryRunPaths: ["dryRun"],
};

const ticketDeclaration = {
  actionFamily: "ticket",
  successStatusPaths: ["receipt.status"],
  providerIdPaths: ["receipt.id"],
  recipientPaths: ["receipt.assignee"],
  bodyPaths: ["receipt.summary"],
  dryRunPaths: ["receipt.dryRun"],
};

describe("external action receipts", () => {
  it("validates evidence declarations", () => {
    expect(isValidExternalActionEvidenceDeclaration(smsDeclaration)).toBe(true);
    expect(
      isValidExternalActionEvidenceDeclaration({
        actionFamily: "",
        providerIdPaths: ["id"],
      }),
    ).toBe(false);
    expect(
      isValidExternalActionEvidenceDeclaration({
        actionFamily: "sms",
      }),
    ).toBe(false);
  });

  it("normalizes successful tool results into evidence", () => {
    expect(
      normalizeExternalActionEvidence({
        declaration: smsDeclaration,
        toolName: "dialpad_send_sms",
        result: {
          id: "4797682962735104",
          status: "accepted/queued",
          from: "+14155201316",
          to: "+13522815065",
          message: "Hello",
        },
      }),
    ).toMatchObject({
      actionFamily: "sms",
      toolName: "dialpad_send_sms",
      providerId: "4797682962735104",
      status: "accepted/queued",
      sender: "+14155201316",
      recipient: "+13522815065",
    });
  });

  it("stringifies primitive provider ids from tool results", () => {
    expect(
      normalizeExternalActionEvidence({
        declaration: smsDeclaration,
        toolName: "dialpad_send_sms",
        result: {
          id: 4797682962735104,
          status: "accepted/queued",
        },
      }),
    ).toMatchObject({
      actionFamily: "sms",
      toolName: "dialpad_send_sms",
      providerId: "4797682962735104",
      status: "accepted/queued",
    });
  });

  it("honors documented created status for non-SMS external actions", () => {
    expect(
      normalizeExternalActionEvidence({
        declaration: ticketDeclaration,
        toolName: "support_create_ticket",
        result: {
          receipt: {
            id: "TICKET-123",
            status: "created",
            assignee: "support",
            summary: "Customer asked for follow-up.",
          },
        },
      }),
    ).toMatchObject({
      actionFamily: "ticket",
      toolName: "support_create_ticket",
      providerId: "TICKET-123",
      status: "created",
      recipient: "support",
    });
  });

  it("rejects dry-run and failed results as success evidence", () => {
    expect(
      normalizeExternalActionEvidence({
        declaration: smsDeclaration,
        result: {
          id: "dry-run-id",
          status: "accepted",
          dryRun: true,
        },
      }),
    ).toBeNull();
    expect(
      normalizeExternalActionEvidence({
        declaration: smsDeclaration,
        result: {
          id: "failed-id",
          status: "failed",
        },
      }),
    ).toBeNull();
  });

  it("normalizes built-in message tool SMS receipts into evidence", () => {
    expect(
      normalizeMessageToolExternalActionEvidence({
        toolName: "message",
        result: {
          channel: "sms",
          messageId: "SM-default",
          chatId: "+15551234567",
          receipt: {
            raw: [
              {
                channel: "sms",
                messageId: "SM-default",
                chatId: "+15551234567",
                toJid: "+15551234567",
                meta: {
                  from: "+15557654321",
                  status: "queued",
                },
              },
            ],
          },
        },
      }),
    ).toEqual([
      expect.objectContaining({
        actionFamily: "sms",
        toolName: "message",
        providerId: "SM-default",
        status: "queued",
        sender: "+15557654321",
        recipient: "+15551234567",
      }),
    ]);
  });
});
