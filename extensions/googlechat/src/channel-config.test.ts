// Googlechat tests cover channel config plugin behavior.
import type { ChannelOutboundPayloadHint } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { describe, expect, it } from "vitest";
import { googlechatPlugin } from "./channel.js";
import { googlechatSetupPlugin } from "./channel.setup.js";

describe("googlechatPlugin config adapter", () => {
  it("keeps setup metadata aligned with the runtime plugin", () => {
    expect(googlechatSetupPlugin.id).toBe(googlechatPlugin.id);
    expect(googlechatSetupPlugin.meta).toEqual(googlechatPlugin.meta);
    expect(googlechatSetupPlugin.capabilities?.chatTypes).toEqual(
      googlechatPlugin.capabilities?.chatTypes,
    );
  });

  it("registers an exec-capable native approval runtime", () => {
    expect(googlechatPlugin.approvalCapability?.nativeRuntime?.eventKinds).toContain("exec");
  });

  it("keeps read-only accessors from resolving service account SecretRefs", () => {
    const cfg = {
      secrets: {
        providers: {
          google_chat_service_account: {
            source: "file",
            path: "/tmp/openclaw-missing-google-chat-service-account",
            mode: "singleValue",
          },
        },
      },
      channels: {
        googlechat: {
          serviceAccount: {
            source: "file",
            provider: "google_chat_service_account",
            id: "value",
          },
          dm: {
            allowFrom: ["users/123"],
          },
          defaultTo: "spaces/AAA",
        },
      },
    } as OpenClawConfig;

    expect(googlechatPlugin.config.resolveAllowFrom?.({ cfg, accountId: "default" })).toEqual([
      "users/123",
    ]);
    expect(googlechatPlugin.config.resolveDefaultTo?.({ cfg, accountId: "default" })).toBe(
      "spaces/AAA",
    );
  });

  it("wires native exec approval suppression through the outbound adapter", () => {
    const cfg = {
      approvals: { exec: { enabled: true } },
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
    } as OpenClawConfig;
    const payload: ReplyPayload = {
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
    const hint: ChannelOutboundPayloadHint = {
      kind: "approval-pending",
      approvalKind: "exec",
      nativeRouteActive: true,
    };

    expect(
      googlechatPlugin.outbound?.shouldSuppressLocalPayloadPrompt?.({
        cfg,
        payload,
        hint,
      }),
    ).toBe(true);
  });
});
