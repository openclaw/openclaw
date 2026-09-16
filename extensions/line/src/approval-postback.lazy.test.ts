// Line tests cover resolving a tapped approval decision through the Gateway.
import type { ApprovalResolveResult } from "openclaw/plugin-sdk/approval-gateway-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildLineApprovalPostbackData,
  resolveLineApprovalPostbackTap,
} from "./approval-postback.js";

const gateway = vi.hoisted(() => ({
  resolveApprovalOverGateway: vi.fn<(params: unknown) => Promise<ApprovalResolveResult>>(),
}));

vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({
  resolveApprovalOverGateway: gateway.resolveApprovalOverGateway,
}));

const approver = "U0123456789abcdef0123456789abcdef";
const lineCredentials = { channelAccessToken: "token", channelSecret: "secret" };
// Cards are on for exec: forwarding reaches the session and an approver is listed.
const cfg: OpenClawConfig = {
  channels: { line: { ...lineCredentials, allowFrom: [approver] } },
  approvals: { exec: { enabled: true } },
};
const common = {
  id: "approval-1",
  urlPath: "/approve/approval-1",
  createdAtMs: 1,
  expiresAtMs: 61_000,
  resolvedAtMs: 2,
  presentation: {
    kind: "exec",
    commandText: "date",
    allowedDecisions: ["allow-once", "allow-always", "deny"],
  },
} satisfies Partial<ApprovalResolveResult["approval"]>;

// Data exactly as a card for this account draws it.
function cardData(decision: "allow-once" | "allow-always" | "deny"): string {
  return (
    buildLineApprovalPostbackData(
      { type: "approval", approvalId: "approval-1", approvalKind: "exec", decision },
      lineCredentials.channelSecret,
    ) ?? ""
  );
}

function tap(decision: "allow-once" | "allow-always" | "deny") {
  return resolveLineApprovalPostbackTap({
    resolveConfig: () => cfg,
    account: { accountId: "default", channelSecret: lineCredentials.channelSecret },
    data: cardData(decision),
    senderId: approver,
  });
}

describe("resolveLineApprovalPostbackTap", () => {
  beforeEach(() => {
    gateway.resolveApprovalOverGateway.mockReset();
  });

  // The Gateway publishes the reviewer display name as the outcome's "Resolved by", so
  // the tap has to leave the sender-derived default in place.
  it("records the decision as the tapping approver and stays silent when it applies", async () => {
    gateway.resolveApprovalOverGateway.mockResolvedValue({
      applied: true,
      approval: { ...common, status: "allowed", decision: "allow-once", reason: "user" },
    });

    await expect(tap("allow-once")).resolves.toBeUndefined();
    expect(gateway.resolveApprovalOverGateway).toHaveBeenCalledWith({
      cfg,
      approvalId: "approval-1",
      approvalKind: "exec",
      decision: "allow-once",
      channel: "line",
      accountId: "default",
      senderId: approver,
    });
  });

  // Same-chat authorization would let a tap skip the command authorization a typed
  // `/approve` goes through, so a tap decides only where cards restrict deciding to
  // listed approvers.
  it.each([
    {
      name: "no approvers are listed",
      config: { channels: { line: lineCredentials }, approvals: { exec: { enabled: true } } },
      senderId: approver,
    },
    {
      name: "cards are off for the account",
      config: { channels: { line: { ...lineCredentials, allowFrom: [approver] } } },
      senderId: approver,
    },
    { name: "the postback names no sender", config: cfg, senderId: undefined },
  ] satisfies { name: string; config: OpenClawConfig; senderId: string | undefined }[])(
    "sends the tap to /approve instead of deciding when $name",
    async ({ config, senderId }) => {
      await expect(
        resolveLineApprovalPostbackTap({
          resolveConfig: () => config,
          account: { accountId: "default", channelSecret: lineCredentials.channelSecret },
          data: cardData("allow-once"),
          ...(senderId ? { senderId } : {}),
        }),
      ).resolves.toBe("Reply /approve approval-1 allow-once to decide this approval.");
      expect(gateway.resolveApprovalOverGateway).not.toHaveBeenCalled();
    },
  );

  it("refuses a tap from someone who is not a listed approver", async () => {
    const notice = await resolveLineApprovalPostbackTap({
      resolveConfig: () => cfg,
      account: { accountId: "default", channelSecret: lineCredentials.channelSecret },
      data: cardData("allow-once"),
      senderId: "U11111111111111111111111111111111",
    });

    expect(notice).toContain("not authorized");
    expect(gateway.resolveApprovalOverGateway).not.toHaveBeenCalled();
  });

  // A resolved approval leaves the pending set within moments, so a tap on an old
  // card usually meets this error. Sending the approver to `/approve` would fail too.
  it("tells a tap on a card nothing waits for any more, instead of offering /approve", async () => {
    gateway.resolveApprovalOverGateway.mockRejectedValue(
      Object.assign(new Error("approval not found"), {
        gatewayCode: "INVALID_REQUEST",
        details: { reason: "APPROVAL_NOT_FOUND" },
      }),
    );

    await expect(tap("deny")).resolves.toBe("That approval is no longer waiting for a decision.");
  });

  // Typed `/approve` resolves only exec and plugin approvals, so pointing an OpenClaw-change
  // tap at it would hand the approver a command that fails.
  it("sends an OpenClaw-change tap to the Control UI instead of /approve", async () => {
    const data =
      buildLineApprovalPostbackData(
        {
          type: "approval",
          approvalId: "approval-1",
          approvalKind: "system-agent",
          decision: "allow-once",
        },
        lineCredentials.channelSecret,
      ) ?? "";
    const openClawChangeTap = (senderId?: string) =>
      resolveLineApprovalPostbackTap({
        resolveConfig: () => cfg,
        account: { accountId: "default", channelSecret: lineCredentials.channelSecret },
        data,
        ...(senderId ? { senderId } : {}),
      });

    await expect(openClawChangeTap()).resolves.toBe("Decide this approval from the Control UI.");
    gateway.resolveApprovalOverGateway.mockRejectedValue(new Error("gateway closed"));
    await expect(openClawChangeTap(approver)).resolves.toBe(
      "Could not record that decision. Decide it from the Control UI instead.",
    );
  });

  it("keeps the /approve fallback when the Gateway could not take the decision", async () => {
    gateway.resolveApprovalOverGateway.mockRejectedValue(new Error("gateway closed"));

    await expect(tap("deny")).resolves.toBe(
      "Could not record that decision. Reply /approve approval-1 deny instead.",
    );
  });

  // Two taps can race the first decision; the loser hears the decision that stands.
  it.each([
    {
      name: "allowed always",
      approval: { ...common, status: "allowed", decision: "allow-always", reason: "user" },
      notice: "This approval was already resolved: Allowed always.",
    },
    {
      name: "denied",
      approval: { ...common, status: "denied", decision: "deny", reason: "user" },
      notice: "This approval was already resolved: Denied.",
    },
    {
      name: "expired",
      approval: { ...common, status: "expired", reason: "timeout" },
      notice: "This approval was already resolved: Expired.",
    },
  ] satisfies { name: string; approval: ApprovalResolveResult["approval"]; notice: string }[])(
    "tells a tap that lost the race the outcome that stands when the approval was $name",
    async ({ approval, notice }) => {
      gateway.resolveApprovalOverGateway.mockResolvedValue({ applied: false, approval });

      await expect(tap("deny")).resolves.toBe(notice);
    },
  );
});
