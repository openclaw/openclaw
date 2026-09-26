import type { ChannelOutboundPayloadHint } from "openclaw/plugin-sdk/channel-contract";
import type { GoogleChatAccountConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
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
  googlechat: GoogleChatAccountConfig = GOOGLE_CHAT_APPROVAL_ACCOUNT,
  approvals: OpenClawConfig["approvals"] = { exec: { enabled: true } },
): OpenClawConfig {
  return { approvals, channels: { googlechat } };
}

const execApprovalPayload: ReplyPayload = {
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
};

const activeExecApprovalHint: ChannelOutboundPayloadHint = {
  kind: "approval-pending",
  approvalKind: "exec",
  nativeRouteActive: true,
};

describe("googleChatApprovalCapability", () => {
  it("declares native exec, plugin, and system-agent approval runtime support", () => {
    const runtime = googleChatApprovalCapability.nativeRuntime;
    expect(runtime?.eventKinds).toEqual(["exec", "plugin", "system-agent"]);
    expect(runtime?.availability.isConfigured({ cfg: approvalConfig() })).toBe(true);
  });

  it("does not enable native cards when webhook callback audience auth is incomplete", () => {
    const runtime = googleChatApprovalCapability.nativeRuntime;
    const account = {
      serviceAccount: GOOGLE_CHAT_APPROVAL_ACCOUNT.serviceAccount,
      allowFrom: ["users/123"],
    };
    expect(runtime?.availability.isConfigured({ cfg: approvalConfig(account) })).toBe(false);
    expect(
      runtime?.availability.isConfigured({
        cfg: approvalConfig({ ...account, audienceType: "project-number" }),
      }),
    ).toBe(false);
  });

  it("requires a top-level approval forwarding route before enabling native cards", () => {
    const runtime = googleChatApprovalCapability.nativeRuntime;
    const googlechat = { ...GOOGLE_CHAT_APPROVAL_ACCOUNT, appPrincipal: undefined };

    expect(runtime?.availability.isConfigured({ cfg: { channels: { googlechat } } })).toBe(false);
    expect(
      runtime?.availability.isConfigured({
        cfg: approvalConfig(googlechat, { exec: { enabled: false } }),
      }),
    ).toBe(false);
    expect(
      runtime?.availability.isConfigured({
        cfg: approvalConfig(googlechat, { exec: { enabled: true, mode: "targets" } }),
      }),
    ).toBe(false);
    expect(
      runtime?.availability.isConfigured({
        cfg: approvalConfig(googlechat, { plugin: { enabled: true } }),
      }),
    ).toBe(true);
  });

  it("enables native cards for supported webhook audience modes", () => {
    const runtime = googleChatApprovalCapability.nativeRuntime;
    const account = { ...GOOGLE_CHAT_APPROVAL_ACCOUNT, appPrincipal: undefined };
    expect(runtime?.availability.isConfigured({ cfg: approvalConfig(account) })).toBe(true);
    expect(
      runtime?.availability.isConfigured({
        cfg: approvalConfig({ ...account, audienceType: "project-number", audience: "1234567890" }),
      }),
    ).toBe(true);
  });

  it("preserves Google Chat approval actor authorization", () => {
    const action = {
      cfg: { channels: { googlechat: { allowFrom: ["users/123"] } } },
      action: "approve" as const,
      approvalKind: "plugin" as const,
    };
    expect(
      googleChatApprovalCapability.authorizeActorAction?.({ ...action, senderId: "users/123" }),
    ).toEqual({ authorized: true });
    expect(
      googleChatApprovalCapability.authorizeActorAction?.({ ...action, senderId: "users/999" }),
    ).toEqual({
      authorized: false,
      reason: "❌ You are not authorized to approve plugin requests on Google Chat.",
    });
  });

  it("only handles approvals for the originating Google Chat account", () => {
    const cfg: OpenClawConfig = {
      approvals: { exec: { enabled: true } },
      channels: {
        googlechat: {
          accounts: {
            alpha: {
              ...GOOGLE_CHAT_APPROVAL_ACCOUNT,
              enabled: true,
              serviceAccount: {
                ...GOOGLE_CHAT_APPROVAL_ACCOUNT.serviceAccount,
                client_email: "alpha@example.com",
              },
              audience: "https://alpha.example.com/googlechat",
            },
            beta: {
              ...GOOGLE_CHAT_APPROVAL_ACCOUNT,
              enabled: true,
              serviceAccount: {
                ...GOOGLE_CHAT_APPROVAL_ACCOUNT.serviceAccount,
                client_email: "beta@example.com",
              },
              audience: "https://beta.example.com/googlechat",
              appPrincipal: "987654321098765432109",
              allowFrom: ["users/456"],
            },
          },
        },
      },
    };
    const request = {
      id: "approval-1",
      request: {
        command: "echo hi",
        turnSourceChannel: "googlechat",
        turnSourceAccountId: "alpha",
        turnSourceTo: "spaces/AAA",
      },
    } as never;

    expect(
      shouldHandleGoogleChatNativeApprovalRequest({
        cfg,
        accountId: "alpha",
        approvalKind: "exec",
        request,
      }),
    ).toBe(true);
    expect(
      shouldHandleGoogleChatNativeApprovalRequest({
        cfg,
        accountId: "beta",
        approvalKind: "exec",
        request,
      }),
    ).toBe(false);
  });

  it("does not handle exec approvals when only plugin approval forwarding is enabled", () => {
    const request = {
      id: "approval-1",
      request: {
        command: "echo hi",
        turnSourceChannel: "googlechat",
        turnSourceTo: "spaces/AAA",
      },
    } as never;

    expect(
      shouldHandleGoogleChatNativeApprovalRequest({
        cfg: approvalConfig(GOOGLE_CHAT_APPROVAL_ACCOUNT, { plugin: { enabled: true } }),
        approvalKind: "exec",
        request,
      }),
    ).toBe(false);
  });

  it("suppresses the local exec prompt when a Google Chat native route is active", () => {
    expect(
      shouldSuppressLocalGoogleChatExecApprovalPrompt({
        cfg: approvalConfig(),
        payload: execApprovalPayload,
        hint: activeExecApprovalHint,
      }),
    ).toBe(true);
  });

  it("keeps the local exec prompt when native Google Chat delivery cannot own it", () => {
    const prompt = { payload: execApprovalPayload, hint: activeExecApprovalHint };
    expect(
      shouldSuppressLocalGoogleChatExecApprovalPrompt({
        ...prompt,
        cfg: approvalConfig(),
        hint: { ...activeExecApprovalHint, nativeRouteActive: false },
      }),
    ).toBe(false);
    expect(
      shouldSuppressLocalGoogleChatExecApprovalPrompt({
        ...prompt,
        cfg: approvalConfig(GOOGLE_CHAT_APPROVAL_ACCOUNT, { exec: { enabled: false } }),
      }),
    ).toBe(false);
    expect(
      shouldSuppressLocalGoogleChatExecApprovalPrompt({
        ...prompt,
        cfg: approvalConfig({ ...GOOGLE_CHAT_APPROVAL_ACCOUNT, audience: undefined }),
      }),
    ).toBe(false);
    expect(
      shouldSuppressLocalGoogleChatExecApprovalPrompt({
        cfg: approvalConfig(),
        payload: {
          channelData: {
            execApproval: {
              approvalId: "12345678-1234-1234-1234-123456789012",
              approvalSlug: "12345678",
              approvalKind: "plugin",
            },
          },
        },
        hint: { kind: "approval-pending", approvalKind: "plugin", nativeRouteActive: true },
      }),
    ).toBe(false);
  });
});
