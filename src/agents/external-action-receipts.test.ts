import { describe, expect, it } from "vitest";
import {
  isValidExternalActionEvidenceDeclaration,
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
});
