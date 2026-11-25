import { isImplicitSameChatApprovalAuthorization } from "openclaw/plugin-sdk/approval-auth-runtime";
import type { ChannelApprovalKind } from "openclaw/plugin-sdk/approval-handler-runtime";
import type { ExecApprovalRequest } from "openclaw/plugin-sdk/approval-runtime";
import type { ChannelOutboundPayloadHint } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { expect, it } from "vitest";
import {
  isMSTeamsNativeApprovalClientEnabled,
  msTeamsApprovalCapability,
  shouldHandleMSTeamsNativeApprovalRequest,
  shouldSuppressLocalMSTeamsExecApprovalPrompt,
} from "./approval-native.js";

const APPROVER_ID = "40a1a0ed-4ff2-4164-a219-55518990c197";
const OTHER_USER_ID = "b2d381f1-36dd-4120-b6fb-8dd37388ff11";
const CONVERSATION_ID = "19:channel@thread.tacv2";

type TeamsConfig = NonNullable<NonNullable<OpenClawConfig["channels"]>["msteams"]>;
function createConfig(
  teams: Partial<TeamsConfig> = {},
  approvals: OpenClawConfig["approvals"] = { exec: { enabled: true } },
): OpenClawConfig {
  return {
    approvals,
    channels: {
      msteams: {
        appId: "app-id",
        appPassword: "app-password",
        tenantId: "tenant-id",
        allowFrom: [APPROVER_ID],
        ...teams,
      },
    },
  };
}

function createExecRequest(): ExecApprovalRequest {
  return {
    id: "approval-1",
    request: {
      command: "echo hello",
      turnSourceChannel: "msteams",
      turnSourceTo: `conversation:${CONVERSATION_ID}`,
      turnSourceAccountId: "default",
    },
    createdAtMs: 0,
    expiresAtMs: 60_000,
  };
}

const pendingExecPayload: ReplyPayload = {
  text: "Approval required.",
  channelData: {
    execApproval: {
      approvalId: "12345678-1234-1234-1234-123456789012",
      approvalSlug: "12345678",
      approvalKind: "exec",
      agentId: "main",
      sessionKey: "agent:main:msteams:channel:example",
    },
  },
};

const activeExecApprovalHint: ChannelOutboundPayloadHint = {
  kind: "approval-pending",
  approvalKind: "exec",
  nativeRouteActive: true,
};

function authorize(
  cfg: OpenClawConfig,
  senderId = APPROVER_ID,
  approvalKind: ChannelApprovalKind = "exec",
) {
  return msTeamsApprovalCapability.authorizeActorActionAsync?.({
    cfg,
    senderId,
    action: "approve",
    approvalKind,
  });
}

function suppress(cfg = createConfig(), hint = activeExecApprovalHint) {
  return shouldSuppressLocalMSTeamsExecApprovalPrompt({ cfg, payload: pendingExecPayload, hint });
}

it("subscribes to exec, plugin, and system-agent approvals for a configured bot and approver", () => {
  const runtime = msTeamsApprovalCapability.nativeRuntimeAsync;

  expect(runtime?.eventKinds).toEqual(["exec", "plugin", "system-agent"]);
  expect(runtime?.availability.isConfigured({ cfg: createConfig() })).toBe(true);
  expect(
    runtime?.availability.isConfigured({
      cfg: createConfig({}, { plugin: { enabled: true } }),
    }),
  ).toBe(true);
});

it.each([
  ["credentials are incomplete", createConfig({ appPassword: undefined })],
  ["approvers lack Entra IDs", createConfig({ allowFrom: ["someone@example.com", "*"] })],
] as const)("does not enable native approvals when %s", (_name, cfg) => {
  expect(isMSTeamsNativeApprovalClientEnabled({ cfg })).toBe(false);
});

it("accepts a valid default destination as the configured approver", async () => {
  const cfg = createConfig({
    allowFrom: undefined,
    defaultTo: `user:${APPROVER_ID.toUpperCase()}`,
  });

  expect(isMSTeamsNativeApprovalClientEnabled({ cfg })).toBe(true);
  expect(await authorize(cfg)).toEqual({ authorized: true });
});

it("keeps authorization available when native forwarding is disabled", async () => {
  const cfg = createConfig({}, { exec: { enabled: false } });

  expect(
    msTeamsApprovalCapability.getActionAvailabilityState?.({
      cfg,
      action: "approve",
      approvalKind: "exec",
    }),
  ).toEqual({ kind: "enabled" });
  expect(await authorize(cfg, APPROVER_ID.toUpperCase())).toEqual({ authorized: true });
});

it("rejects unlisted actors for both approval kinds", async () => {
  for (const approvalKind of ["exec", "plugin"] as const) {
    expect(await authorize(createConfig(), OTHER_USER_ID, approvalKind)).toEqual({
      authorized: false,
      reason: `❌ You are not authorized to approve ${approvalKind} requests on Microsoft Teams.`,
    });
  }
});

it("preserves implicit same-chat authorization when no approvers are configured", async () => {
  const authorization = await authorize(createConfig({ allowFrom: undefined }), OTHER_USER_ID);

  expect(authorization).toEqual({ authorized: true });
  expect(isImplicitSameChatApprovalAuthorization(authorization)).toBe(true);
});

it("routes each approval only through its bound Teams account and originating channel", async () => {
  const cfg = createConfig({
    defaultAccount: "support",
    accounts: {
      support: { appId: "support-app", appPassword: "support-password" },
    },
  });
  const request = createExecRequest();
  const handles = (accountId?: string, overrides: Partial<ExecApprovalRequest["request"]> = {}) =>
    shouldHandleMSTeamsNativeApprovalRequest({
      cfg,
      accountId,
      approvalKind: "exec",
      request: { ...request, request: { ...request.request, ...overrides } },
    });
  expect(await handles("default")).toBe(true);
  expect(await handles("support", { turnSourceAccountId: "support" })).toBe(true);
  expect(await handles("support")).toBe(false);
  expect(await handles(undefined, { turnSourceChannel: "slack" })).toBe(false);
  expect(await handles(undefined, { turnSourceTo: "  " })).toBe(false);
});

it("maps stable allowlisted approvers to user-prefixed Teams DM targets", async () => {
  expect(
    await msTeamsApprovalCapability.nativeAsync?.resolveApproverDmTargets?.({
      cfg: createConfig(),
      accountId: "default",
      approvalKind: "exec",
      request: createExecRequest(),
    }),
  ).toEqual([{ to: `user:${APPROVER_ID}`, accountId: "default" }]);
});

it("suppresses the duplicate text prompt only while native exec delivery owns it", () => {
  expect(suppress()).toBe(true);
  expect(suppress(createConfig(), { ...activeExecApprovalHint, nativeRouteActive: false })).toBe(
    false,
  );
  expect(suppress(createConfig({}, { exec: { enabled: false } }))).toBe(false);
});

it("describes the existing Teams allowlist and default destination setup", () => {
  const guidance = msTeamsApprovalCapability.describeExecApprovalSetup?.({
    channel: "msteams",
    channelLabel: "Microsoft Teams",
  });

  expect(guidance).toContain("`channels.msteams.allowFrom`");
  expect(guidance).toContain("Approve it from the Web UI for now.");
  expect(guidance).not.toMatch(/terminal UI|\bTUI\b/i);
  expect(guidance).toContain("`channels.msteams.defaultTo`");
});
