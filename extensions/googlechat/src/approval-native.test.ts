import type { GoogleChatConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import {
  googleChatApprovalCapability,
  shouldHandleGoogleChatNativeApprovalRequest,
  shouldSuppressLocalGoogleChatExecApprovalPrompt,
} from "./approval-native.js";

const GOOGLE_CHAT_APPROVAL_ACCOUNT = {
  serviceAccount: {
    type: "service_account" as const,
    client_email: "bot@example.com",
    private_key: "test-key",
    token_uri: "https://oauth2.googleapis.com/token",
  },
  audienceType: "app-url" as const,
  audience: "https://chat-app.example.test/googlechat",
  appPrincipal: "123456789012345678901",
  allowFrom: ["users/123"],
};

function approvalConfig(
  googlechat: GoogleChatConfig = GOOGLE_CHAT_APPROVAL_ACCOUNT,
  approvals: OpenClawConfig["approvals"] = { exec: { enabled: true } },
): OpenClawConfig {
  return { approvals, channels: { googlechat } };
}

const approvalRequest = {
  id: "approval-1",
  request: {
    command: "echo hi",
    turnSourceChannel: "googlechat",
    turnSourceTo: "spaces/AAA",
  },
};

describe("googleChatApprovalCapability", () => {
  it("directs exec approval recovery to the Web UI and account setup", () => {
    const text = googleChatApprovalCapability.describeExecApprovalSetup?.({
      channel: "googlechat",
      channelLabel: "Google Chat",
      accountId: "work",
    });

    expect(text).toContain("Approve it from the Web UI for now.");
    expect(text).not.toMatch(/terminal UI|\bTUI\b/i);
    expect(text).toContain("`channels.googlechat.accounts.work.allowFrom`");
    expect(text).toContain("`channels.googlechat.accounts.work.defaultTo`");
  });

  it("preserves Google Chat approval actor authorization", async () => {
    const action = {
      cfg: { channels: { googlechat: { allowFrom: ["users/123"] } } },
      action: "approve" as const,
      approvalKind: "plugin" as const,
    };
    const authorize = (senderId: string) =>
      googleChatApprovalCapability.authorizeActorActionAsync?.({ ...action, senderId });
    expect(await authorize("users/123")).toEqual({ authorized: true });
    expect(await authorize("users/999")).toEqual({
      authorized: false,
      reason: "❌ You are not authorized to approve plugin requests on Google Chat.",
    });
  });

  it("only handles approvals for the originating Google Chat account", async () => {
    const cfg = approvalConfig({
      accounts: {
        alpha: GOOGLE_CHAT_APPROVAL_ACCOUNT,
        beta: { ...GOOGLE_CHAT_APPROVAL_ACCOUNT, allowFrom: ["users/456"] },
      },
    });
    const request = {
      ...approvalRequest,
      request: { ...approvalRequest.request, turnSourceAccountId: "alpha" },
    } as never;

    const params = { cfg, approvalKind: "exec" as const, request };
    expect(
      await shouldHandleGoogleChatNativeApprovalRequest({ ...params, accountId: "alpha" }),
    ).toBe(true);
    expect(
      await shouldHandleGoogleChatNativeApprovalRequest({ ...params, accountId: "beta" }),
    ).toBe(false);
  });

  it("does not handle exec approvals when only plugin approval forwarding is enabled", async () => {
    expect(
      await shouldHandleGoogleChatNativeApprovalRequest({
        cfg: approvalConfig(GOOGLE_CHAT_APPROVAL_ACCOUNT, { plugin: { enabled: true } }),
        approvalKind: "exec",
        request: approvalRequest as never,
      }),
    ).toBe(false);
  });

  it("suppresses the local exec prompt when a Google Chat native route is active", () => {
    expect(
      shouldSuppressLocalGoogleChatExecApprovalPrompt({
        cfg: approvalConfig(),
        payload: {
          text: "I need approval to run this command.",
          channelData: {
            execApproval: {
              approvalId: "12345678-1234-1234-1234-123456789012",
              approvalSlug: "12345678",
              approvalKind: "exec",
              agentId: "dev",
              sessionKey: "agent:dev:main",
            },
          },
        },
        hint: { kind: "approval-pending", approvalKind: "exec", nativeRouteActive: true },
      }),
    ).toBe(true);
  });
});
