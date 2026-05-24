import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { imessageApprovalCapability, imessageNativeApprovalAdapter } from "./approval-native.js";

type IMessageConfig = NonNullable<NonNullable<OpenClawConfig["channels"]>["imessage"]>;

function buildConfig(
  params: {
    imessage?: Partial<IMessageConfig>;
    approvals?: OpenClawConfig["approvals"];
  } = {},
): OpenClawConfig {
  return {
    channels: {
      imessage: {
        enabled: true,
        ...params.imessage,
      },
    },
    approvals: params.approvals,
  } as OpenClawConfig;
}

function buildExecRequest(
  turnSourceTo: string,
  overrides: Partial<ExecApprovalRequest["request"]> = {},
): ExecApprovalRequest {
  return {
    id: "exec-1",
    request: {
      command: "echo hi",
      agentId: "main",
      turnSourceChannel: "imessage",
      turnSourceTo,
      turnSourceAccountId: "default",
      sessionKey: `agent:main:imessage:${turnSourceTo}`,
      ...overrides,
    },
    createdAtMs: 0,
    expiresAtMs: 1000,
  };
}

function buildPluginRequest(
  turnSourceTo: string,
  overrides: Partial<PluginApprovalRequest["request"]> = {},
): PluginApprovalRequest {
  return {
    id: "plugin:approval-1",
    request: {
      title: "Plugin approval",
      description: "Allow plugin action",
      agentId: "main",
      turnSourceChannel: "imessage",
      turnSourceTo,
      turnSourceAccountId: "default",
      sessionKey: `agent:main:imessage:${turnSourceTo}`,
      ...overrides,
    },
    createdAtMs: 0,
    expiresAtMs: 1000,
  };
}

function nativeShouldHandle(params: {
  cfg: OpenClawConfig;
  request: ExecApprovalRequest | PluginApprovalRequest;
  accountId?: string | null;
}) {
  return imessageApprovalCapability.nativeRuntime?.availability.shouldHandle({
    cfg: params.cfg,
    accountId: params.accountId ?? "default",
    context: {},
    request: params.request,
  });
}

describe("imessage approval capability", () => {
  it("disables native approvals when no top-level approvals config is set", () => {
    const cfg = buildConfig();
    const execRequest = buildExecRequest("+15551230000");
    const pluginRequest = buildPluginRequest("+15551230000");

    expect(
      imessageNativeApprovalAdapter.auth?.getActionAvailabilityState?.({
        cfg,
        accountId: "default",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ kind: "disabled" });
    expect(
      imessageApprovalCapability.native?.describeDeliveryCapabilities({
        cfg,
        accountId: "default",
        approvalKind: "exec",
        request: execRequest,
      }).enabled,
    ).toBe(false);
    expect(nativeShouldHandle({ cfg, request: execRequest })).toBe(false);
    expect(nativeShouldHandle({ cfg, request: pluginRequest })).toBe(false);
  });

  it("allows session-mode exec delivery for matching iMessage origins", () => {
    const cfg = buildConfig({ approvals: { exec: { enabled: true } } });
    const request = buildExecRequest("+15551230000");

    expect(
      imessageApprovalCapability.native?.describeDeliveryCapabilities({
        cfg,
        accountId: "default",
        approvalKind: "exec",
        request,
      }),
    ).toEqual({
      enabled: true,
      preferredSurface: "origin",
      supportsOriginSurface: true,
      supportsApproverDmSurface: false,
      notifyOriginWhenDmOnly: true,
    });
    expect(nativeShouldHandle({ cfg, request })).toBe(true);
  });

  it("keeps exec and plugin forwarding gates independent", () => {
    const execOnly = buildConfig({ approvals: { exec: { enabled: true } } });
    const pluginOnly = buildConfig({ approvals: { plugin: { enabled: true } } });

    expect(nativeShouldHandle({ cfg: execOnly, request: buildPluginRequest("+15551230000") })).toBe(
      false,
    );
    expect(nativeShouldHandle({ cfg: pluginOnly, request: buildExecRequest("+15551230000") })).toBe(
      false,
    );
    expect(
      nativeShouldHandle({ cfg: pluginOnly, request: buildPluginRequest("+15551230000") }),
    ).toBe(true);
  });

  it("does not use session mode for non-iMessage-origin requests", () => {
    const cfg = buildConfig({ approvals: { exec: { enabled: true } } });
    const request = buildExecRequest("", {
      turnSourceChannel: "slack",
      turnSourceTo: "C123",
      sessionKey: "agent:main:slack:channel:c123",
    });

    expect(nativeShouldHandle({ cfg, request })).toBe(false);
    expect(
      imessageApprovalCapability.native?.describeDeliveryCapabilities({
        cfg,
        accountId: "default",
        approvalKind: "exec",
        request,
      }).enabled,
    ).toBe(false);
  });

  it("rejects group origin targets when no approvers are configured", () => {
    const cfg = buildConfig({ approvals: { exec: { enabled: true } } });
    const request = buildExecRequest("chat_guid:iMessage;+;chat42");

    expect(
      imessageApprovalCapability.native?.resolveOriginTarget?.({
        cfg,
        accountId: "default",
        approvalKind: "exec",
        request,
      }),
    ).toBeNull();
  });

  it("allows group origin targets when explicit approvers are configured", () => {
    const cfg = buildConfig({
      imessage: { allowFrom: ["+15551230000"] },
      approvals: { exec: { enabled: true } },
    });
    const request = buildExecRequest("chat_guid:iMessage;+;chat42");

    expect(
      imessageApprovalCapability.native?.resolveOriginTarget?.({
        cfg,
        accountId: "default",
        approvalKind: "exec",
        request,
      }),
    ).toEqual({
      to: "chat_guid:iMessage;+;chat42",
      accountId: "default",
    });
  });

  it("resolves approver-dm targets from channels.imessage.allowFrom when the request is session-eligible", () => {
    const cfg = buildConfig({
      imessage: { allowFrom: ["+15551230000", "owner@example.com"] },
      approvals: { exec: { enabled: true } },
    });
    const request = buildExecRequest("+15551239999");

    const targets = imessageApprovalCapability.native?.resolveApproverDmTargets?.({
      cfg,
      accountId: "default",
      approvalKind: "exec",
      request,
    });

    expect(targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ to: "+15551230000" }),
        expect.objectContaining({ to: "owner@example.com" }),
      ]),
    );
  });

  it("uses target-mode config for requestless availability without native runtime handling", () => {
    const cfg = buildConfig({
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "imessage", to: "+15551230000" }],
        },
      },
    });
    const request = buildExecRequest("+15551230000");

    expect(
      imessageNativeApprovalAdapter.auth?.getActionAvailabilityState?.({
        cfg,
        accountId: "default",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ kind: "enabled" });
    expect(
      imessageApprovalCapability.nativeRuntime?.availability.isConfigured({
        cfg,
        accountId: "default",
        context: {},
      }),
    ).toBe(false);
    expect(nativeShouldHandle({ cfg, request })).toBe(false);
  });

  it("disables delivery when the iMessage channel is disabled", () => {
    const cfg = buildConfig({
      imessage: { enabled: false },
      approvals: { exec: { enabled: true } },
    });
    const request = buildExecRequest("+15551230000");

    expect(
      imessageApprovalCapability.native?.describeDeliveryCapabilities({
        cfg,
        accountId: "default",
        approvalKind: "exec",
        request,
      }).enabled,
    ).toBe(false);
    expect(nativeShouldHandle({ cfg, request })).toBe(false);
  });

  it("renders thumbs-only reaction hints in exec approval prompts", () => {
    const payload = imessageApprovalCapability.render?.exec?.buildPendingPayload?.({
      cfg: buildConfig(),
      accountId: "default",
      request: buildExecRequest("+15551230000"),
      nowMs: 0,
    });

    expect(payload?.text).toContain("👍 Allow Once");
    expect(payload?.text).toContain("👎 Deny");
  });

  it("renders thumbs-only reaction hints in plugin approval prompts and respects allowed decisions", () => {
    const payload = imessageApprovalCapability.render?.plugin?.buildPendingPayload?.({
      cfg: buildConfig(),
      accountId: "default",
      request: buildPluginRequest("+15551230000", {
        allowedDecisions: ["allow-once", "deny"],
      }) as never,
      nowMs: 0,
    });

    expect(payload?.text).toContain("👍 Allow Once");
    expect(payload?.text).toContain("👎 Deny");
    expect(payload?.text).not.toContain("Allow Always");
  });
});
