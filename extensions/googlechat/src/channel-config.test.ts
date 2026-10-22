import type { GoogleChatConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { inspectGoogleChatAccount } from "./accounts.js";
import {
  registerGoogleChatApprovalCardBinding,
  googleChatApprovalControls,
} from "./approval-card-actions.js";
import { googlechatPlugin } from "./channel.js";

const channelConfig = (googlechat: GoogleChatConfig): OpenClawConfig => ({
  channels: { googlechat },
});
const missingRef = { source: "env", provider: "default", id: "MISSING_GOOGLECHAT" } as const;

describe("googlechatPlugin config adapter", () => {
  const normalize = (payload: ReplyPayload) =>
    googlechatPlugin.outbound?.normalizePayload?.({ cfg: {}, payload });
  afterEach(() => googleChatApprovalControls.unregister(["token-1"]));

  it.each([
    { serviceAccount: missingRef, configured: true },
    { serviceAccount: undefined, configured: false },
  ])("inspects service account configuration as configured=$configured", async (entry) => {
    const accountConfig = {
      serviceAccount: entry.serviceAccount,
      audienceType: "app-url" as const,
      audience: "https://bot.example.com/googlechat",
      webhookPath: "/googlechat",
      webhookUrl: "https://bot.example.com/googlechat",
    };
    const cfg = channelConfig({ accounts: { work: accountConfig } });
    const account = inspectGoogleChatAccount({ cfg, accountId: "work" });
    expect(await googlechatPlugin.config.isConfigured?.(account, cfg)).toBe(entry.configured);
    expect(account).toMatchObject({
      accountId: "work",
      enabled: true,
      configured: entry.configured,
      credentialSource: "none",
      audienceType: "app-url",
      audience: "https://bot.example.com/googlechat",
      webhookPath: "/googlechat",
      webhookUrl: "https://bot.example.com/googlechat",
      dmPolicy: "pairing",
    });
    expect(googlechatPlugin.status?.collectStatusIssues?.([account])).toEqual([]);
  });

  it("classifies Google Chat users as direct and spaces as groups", () => {
    const inferTargetChatType = googlechatPlugin.messaging?.inferTargetChatType;

    expect(inferTargetChatType?.({ to: "users/abc" })).toBe("direct");
    expect(inferTargetChatType?.({ to: "spaces/xyz" })).toBe("group");
    expect(inferTargetChatType?.({ to: "unknown" })).toBeUndefined();
  });

  it("does not advertise user-auth-only actions", () => {
    const cfg = channelConfig({ serviceAccount: { client_email: "bot@example.com" } });

    expect(googlechatPlugin.actions?.describeMessageTool?.({ cfg })).toEqual({
      actions: ["send"],
    });
    expect(googlechatPlugin.actions?.supportsAction?.({ action: "send" })).toBe(true);
    expect(googlechatPlugin.actions?.supportsAction?.({ action: "upload-file" })).toBe(false);
  });

  it("keeps read-only accessors from resolving service account SecretRefs", () => {
    const cfg = {
      ...channelConfig({
        serviceAccount: { source: "file", provider: "missing", id: "value" },
        allowFrom: ["users/123"],
        defaultTo: "spaces/AAA",
      }),
      secrets: {
        providers: {
          missing: {
            source: "file",
            path: "/tmp/openclaw-missing-google-chat-service-account",
            mode: "singleValue",
          },
        },
      },
    } as OpenClawConfig;

    const params = { cfg, accountId: "default" };
    expect({
      allowFrom: googlechatPlugin.config.resolveAllowFrom?.(params),
      defaultTo: googlechatPlugin.config.resolveDefaultTo?.(params),
    }).toEqual({ allowFrom: ["users/123"], defaultTo: "spaces/AAA" });
  });

  it("keeps unrelated or sendable structured approval-looking payloads visible", () => {
    const approvalId = "12345678-1234-1234-1234-123456789012";
    registerGoogleChatApprovalCardBinding({
      token: "token-1",
      accountId: "default",
      approvalId,
      approvalKind: "exec",
      decision: "allow-once",
      allowedDecisions: ["allow-once", "deny"],
      spaceName: "spaces/AAA",
      messageName: "spaces/AAA/messages/msg-1",
      expiresAtMs: Date.now() + 60_000,
    });
    const text = `/approve ${approvalId.slice(0, 8)} allow-once`;
    const unrelatedPayload: ReplyPayload = { text: "/approve deadbeef allow-once" };
    const metadataPayload: ReplyPayload = { text, channelData: { execApproval: { approvalId } } };
    const structuredPayload: ReplyPayload = { text, presentation: { blocks: [] } };

    expect(normalize(unrelatedPayload)).toBe(unrelatedPayload);
    expect(normalize(metadataPayload)).toBeNull();
    expect(normalize(structuredPayload)).toBe(structuredPayload);
  });
});
