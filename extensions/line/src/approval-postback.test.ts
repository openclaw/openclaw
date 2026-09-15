// Line tests cover the postback encoding for approval decision controls.

import { createHmac } from "node:crypto";
import { buildApprovalResolutionRef } from "openclaw/plugin-sdk/approval-reference-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LINE_ACTION_DATA_LIMIT } from "./actions.js";
import {
  buildLineApprovalPostbackData,
  hasLineApprovalPostbackData,
  resolveLineApprovalPostbackTap,
} from "./approval-postback.js";

type ApprovalDecisionControl = Parameters<typeof buildLineApprovalPostbackData>[0];

const CHANNEL_SECRET = "line-channel-secret";
// Unverifiable data decides nothing, but the tapper is told so and pointed elsewhere:
// pending approvals are not sent again as new cards after the channel secret changes.
const UNVERIFIED_NOTICE =
  "Nothing was decided: this approval button could not be verified. Use the Control UI, or for an exec or plugin approval reply /approve with the approval ID shown on the card and your decision.";

const gateway = vi.hoisted(() => ({
  resolveApprovalOverGateway: vi.fn<(params: object) => Promise<undefined>>(async () => undefined),
}));

vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({
  resolveApprovalOverGateway: gateway.resolveApprovalOverGateway,
}));

const approval = (overrides: Partial<ApprovalDecisionControl> = {}): ApprovalDecisionControl => ({
  type: "approval",
  approvalId: "6f4a1b2c-0d3e-4f5a-8b9c-0d1e2f3a4b5c",
  approvalKind: "exec",
  decision: "allow-once",
  ...overrides,
});

// The tap is the only reader of this data, so what the Gateway receives is the contract.
async function tapped(data: string) {
  gateway.resolveApprovalOverGateway.mockClear();
  const notice = await resolveLineApprovalPostbackTap({
    // Cards on for every kind (system-agent follows exec), so the tap decides.
    resolveConfig: () => ({
      channels: {
        line: {
          channelAccessToken: "token",
          channelSecret: CHANNEL_SECRET,
          allowFrom: ["U0123456789abcdef0123456789abcdef"],
        },
      },
      approvals: { exec: { enabled: true }, plugin: { enabled: true } },
    }),
    account: { accountId: "default", channelSecret: CHANNEL_SECRET },
    data,
    senderId: "U0123456789abcdef0123456789abcdef",
  });
  return {
    notice,
    resolved: gateway.resolveApprovalOverGateway.mock.calls.map(([params]) => params),
  };
}

describe("LINE approval postback data", () => {
  beforeEach(() => {
    gateway.resolveApprovalOverGateway.mockClear();
  });

  it("resolves every decision the control can offer", async () => {
    for (const decision of ["allow-once", "allow-always", "deny"] as const) {
      for (const approvalKind of ["exec", "plugin", "system-agent"] as const) {
        const data = buildLineApprovalPostbackData(
          approval({ approvalKind, decision }),
          CHANNEL_SECRET,
        );
        expect(data).toBeDefined();
        expect((await tapped(data ?? "")).resolved).toEqual([
          expect.objectContaining({ approvalId: approval().approvalId, approvalKind, decision }),
        ]);
      }
    }
  });

  it("keeps the exact approval id when it fits the action data ceiling", async () => {
    const data = buildLineApprovalPostbackData(approval(), CHANNEL_SECRET) ?? "";
    expect(data.length).toBeLessThanOrEqual(LINE_ACTION_DATA_LIMIT);
    expect((await tapped(data)).resolved).toEqual([
      expect.objectContaining({ approvalId: approval().approvalId }),
    ]);
  });

  it("falls back to a digest locator instead of dropping an oversized id", async () => {
    const approvalId = "x".repeat(LINE_ACTION_DATA_LIMIT + 1);
    const data = buildLineApprovalPostbackData(approval({ approvalId }), CHANNEL_SECRET);
    expect(data).toBeDefined();
    expect((data ?? "").length).toBeLessThanOrEqual(LINE_ACTION_DATA_LIMIT);
    expect((await tapped(data ?? "")).resolved).toEqual([
      expect.objectContaining({
        approvalId: buildApprovalResolutionRef({ approvalId, approvalKind: "exec" }),
      }),
    ]);
  });

  it("reserves the namespace for data it cannot read", async () => {
    // bot-handlers must consume a malformed approval postback instead of letting
    // its raw data reach the agent as a turn.
    const malformed = "line.approval=&line.approvalKind=exec&line.decision=allow-once";
    expect(hasLineApprovalPostbackData(malformed)).toBe(true);
    expect(await tapped(malformed)).toEqual({ notice: UNVERIFIED_NOTICE, resolved: [] });
  });

  it("ignores postback data from another control", () => {
    expect(hasLineApprovalPostbackData("line.question=q-1&line.option=0")).toBe(false);
  });

  // Data that merely names an approval must not decide it: only a card built for this
  // account can.
  it("does not decide from approval data no card for this account built", async () => {
    const signed = buildLineApprovalPostbackData(approval(), CHANNEL_SECRET) ?? "";
    const fields = signed.replace(/&line\.sig=[^&]*$/, "");
    for (const data of [
      fields,
      `${fields}&line.sig=${"A".repeat(22)}`,
      buildLineApprovalPostbackData(approval(), "another-channel-secret") ?? "",
      signed.replace("line.decision=allow-once", "line.decision=allow-always"),
    ]) {
      expect(hasLineApprovalPostbackData(data)).toBe(true);
      expect(await tapped(data)).toEqual({ notice: UNVERIFIED_NOTICE, resolved: [] });
    }
    expect((await tapped(signed)).resolved).toHaveLength(1);
  });

  // An unreadable secret file leaves the account with an empty secret while the webhook
  // keeps verifying with the one it started with. A tag made with an empty key is one
  // anyone can compute, so it must never decide, and no card is drawn with it.
  it("neither draws nor accepts a tag made without a channel secret", async () => {
    expect(buildLineApprovalPostbackData(approval(), "")).toBeUndefined();

    const fields = new URLSearchParams({
      "line.approval": approval().approvalId,
      "line.approvalKind": "exec",
      "line.decision": "allow-once",
    }).toString();
    const emptyKey = createHmac("sha256", "openclaw-line-approval-postback").update("").digest();
    const tag = createHmac("sha256", emptyKey).update(fields).digest("base64url").slice(0, 22);
    gateway.resolveApprovalOverGateway.mockClear();
    // Cards are on and the sender is the listed approver, so only the tag check stands
    // between this data and a recorded decision.
    const notice = await resolveLineApprovalPostbackTap({
      resolveConfig: () => ({
        channels: {
          line: {
            channelAccessToken: "token",
            channelSecret: CHANNEL_SECRET,
            allowFrom: ["U0123456789abcdef0123456789abcdef"],
          },
        },
        approvals: { exec: { enabled: true } },
      }),
      account: { accountId: "default", channelSecret: "" },
      data: `${fields}&line.sig=${tag}`,
      senderId: "U0123456789abcdef0123456789abcdef",
    });
    expect(notice).toBe(UNVERIFIED_NOTICE);
    expect(gateway.resolveApprovalOverGateway).not.toHaveBeenCalled();
  });

  it("rejects an unknown kind or decision", async () => {
    for (const data of [
      "line.approval=a1&line.approvalKind=elevated&line.decision=allow-once",
      "line.approval=a1&line.approvalKind=exec&line.decision=allow-forever",
      "line.approval=a1&line.approvalKind=exec",
    ]) {
      expect(hasLineApprovalPostbackData(data)).toBe(true);
      expect(await tapped(data)).toEqual({ notice: UNVERIFIED_NOTICE, resolved: [] });
    }
  });
});
