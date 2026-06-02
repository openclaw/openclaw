import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import {
  googleChatApprovalCapability,
  shouldHandleGoogleChatNativeApprovalRequest,
} from "./approval-native.js";

describe("googleChatApprovalCapability", () => {
  it("declares native exec and plugin approval runtime support", async () => {
    const runtime = googleChatApprovalCapability.nativeRuntime;
    expect(runtime?.eventKinds).toEqual(["exec", "plugin"]);
    expect(
      runtime?.availability.isConfigured({
        cfg: {
          channels: {
            googlechat: {
              serviceAccount: {
                type: "service_account",
                client_email: "bot@example.com",
                private_key: "test-key",
                token_uri: "https://oauth2.googleapis.com/token",
              },
              audienceType: "app-url",
              audience: "https://chat-app.example.test/googlechat",
              appPrincipal: "123456789012345678901",
              dm: { allowFrom: ["users/123"] },
            },
          },
        },
      }),
    ).toBe(true);
  });

  it("does not enable native cards when webhook callback audience auth is incomplete", async () => {
    const runtime = googleChatApprovalCapability.nativeRuntime;
    expect(
      runtime?.availability.isConfigured({
        cfg: {
          channels: {
            googlechat: {
              serviceAccount: {
                type: "service_account",
                client_email: "bot@example.com",
                private_key: "test-key",
                token_uri: "https://oauth2.googleapis.com/token",
              },
              dm: { allowFrom: ["users/123"] },
            },
          },
        },
      }),
    ).toBe(false);
    expect(
      runtime?.availability.isConfigured({
        cfg: {
          channels: {
            googlechat: {
              serviceAccount: {
                type: "service_account",
                client_email: "bot@example.com",
                private_key: "test-key",
                token_uri: "https://oauth2.googleapis.com/token",
              },
              audienceType: "project-number",
              dm: { allowFrom: ["users/123"] },
            },
          },
        },
      }),
    ).toBe(false);
  });

  it("enables native cards for supported webhook audience modes", async () => {
    const runtime = googleChatApprovalCapability.nativeRuntime;
    expect(
      runtime?.availability.isConfigured({
        cfg: {
          channels: {
            googlechat: {
              serviceAccount: {
                type: "service_account",
                client_email: "bot@example.com",
                private_key: "test-key",
                token_uri: "https://oauth2.googleapis.com/token",
              },
              audienceType: "app-url",
              audience: "https://chat-app.example.test/googlechat",
              dm: { allowFrom: ["users/123"] },
            },
          },
        },
      }),
    ).toBe(true);
    expect(
      runtime?.availability.isConfigured({
        cfg: {
          channels: {
            googlechat: {
              serviceAccount: {
                type: "service_account",
                client_email: "bot@example.com",
                private_key: "test-key",
                token_uri: "https://oauth2.googleapis.com/token",
              },
              audienceType: "project-number",
              audience: "1234567890",
              dm: { allowFrom: ["users/123"] },
            },
          },
        },
      }),
    ).toBe(true);
  });

  it("preserves Google Chat approval actor authorization", () => {
    expect(
      googleChatApprovalCapability.authorizeActorAction?.({
        cfg: { channels: { googlechat: { dm: { allowFrom: ["users/123"] } } } },
        senderId: "users/123",
        action: "approve",
        approvalKind: "plugin",
      }),
    ).toEqual({ authorized: true });

    expect(
      googleChatApprovalCapability.authorizeActorAction?.({
        cfg: { channels: { googlechat: { dm: { allowFrom: ["users/123"] } } } },
        senderId: "users/999",
        action: "approve",
        approvalKind: "plugin",
      }),
    ).toEqual({
      authorized: false,
      reason: "❌ You are not authorized to approve plugin requests on Google Chat.",
    });
  });

  it("only handles approvals for the originating Google Chat account", () => {
    const cfg: OpenClawConfig = {
      channels: {
        googlechat: {
          accounts: {
            alpha: {
              enabled: true,
              serviceAccount: {
                type: "service_account",
                client_email: "alpha@example.com",
                private_key: "test-key",
                token_uri: "https://oauth2.googleapis.com/token",
              },
              audienceType: "app-url",
              audience: "https://alpha.example.com/googlechat",
              appPrincipal: "123456789012345678901",
              dm: { allowFrom: ["users/123"] },
            },
            beta: {
              enabled: true,
              serviceAccount: {
                type: "service_account",
                client_email: "beta@example.com",
                private_key: "test-key",
                token_uri: "https://oauth2.googleapis.com/token",
              },
              audienceType: "app-url",
              audience: "https://beta.example.com/googlechat",
              appPrincipal: "987654321098765432109",
              dm: { allowFrom: ["users/456"] },
            },
          },
        },
      },
    };
    const request = {
      id: "approval-1",
      request: {
        turnSourceChannel: "googlechat",
        turnSourceAccountId: "alpha",
        turnSourceTo: "spaces/AAA",
      },
    } as never;

    expect(
      shouldHandleGoogleChatNativeApprovalRequest({
        cfg,
        accountId: "alpha",
        request,
      }),
    ).toBe(true);
    expect(
      shouldHandleGoogleChatNativeApprovalRequest({
        cfg,
        accountId: "beta",
        request,
      }),
    ).toBe(false);
  });
});
