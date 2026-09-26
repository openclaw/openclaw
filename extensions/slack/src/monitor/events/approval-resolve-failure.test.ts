import { describe, expect, it } from "vitest";
import { describeSlackApprovalResolveFailure } from "./approval-resolve-failure.js";

// The clicker is told what the Gateway answered; only a transport failure is surfaced as one.
describe("describeSlackApprovalResolveFailure", () => {
  it.each([
    [
      "a refusal",
      Object.assign(new Error("approval decision requires a listed approver"), {
        gatewayCode: "FORBIDDEN",
        details: { code: "APPROVAL_AUTHORITY_REQUIRED" },
      }),
      "That decision needs an approver listed for this channel. Ask a listed approver to decide it.",
      false,
    ],
    [
      "a missing approval",
      new Error("unknown or expired approval id"),
      "This approval is no longer pending.",
      false,
    ],
    [
      "a transport failure",
      new Error("gateway 503"),
      "Could not reach the Gateway to resolve this approval. Try again.",
      true,
    ],
  ])("answers %s", (_label, error, text, unexpected) => {
    expect(describeSlackApprovalResolveFailure(error)).toEqual({ text, unexpected });
  });
});
