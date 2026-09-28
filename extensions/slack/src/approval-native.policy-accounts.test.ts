import type { PluginApprovalRequest } from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { slackApprovalCapability } from "./approval-native.js";
import { registerSlackInstallationState } from "./installation-identity-state.js";

type SlackInstallationStateRegistration = ReturnType<typeof registerSlackInstallationState>;
const installationStates: SlackInstallationStateRegistration[] = [];

afterEach(() => {
  for (const installationState of installationStates.splice(0)) {
    installationState.release();
  }
});

function buildPluginRequest(
  request: Partial<PluginApprovalRequest["request"]> = {},
  id = "plugin:req-1",
): PluginApprovalRequest {
  return {
    id,
    request: { title: "Plugin approval", description: "Allow access", ...request },
    createdAtMs: 0,
    expiresAtMs: 1000,
  };
}

function buildConfig(
  overrides?: Partial<NonNullable<NonNullable<OpenClawConfig["channels"]>["slack"]>>,
): OpenClawConfig {
  return {
    channels: {
      slack: {
        botToken: "xoxb-test",
        appToken: "xapp-test",
        execApprovals: {
          enabled: true,
          approvers: ["U123APPROVER"],
          target: "both",
        },
        ...overrides,
      },
    },
  } as OpenClawConfig;
}

describe("Slack plugin approval reviewer account policy", () => {
  it("does not deliver an unbound plugin approval from ambiguous Slack accounts", async () => {
    for (const accountId of ["default", "ops"]) {
      installationStates.push(registerSlackInstallationState(accountId, "workspace", "T11111111"));
    }
    const cfg = {
      channels: {
        slack: {
          accounts: {
            default: { botToken: "xoxb-default", appToken: "xapp-default" },
            ops: { botToken: "xoxb-ops", appToken: "xapp-ops" },
          },
        },
      },
      approvals: {
        plugin: { slack: { approvers: ["team:T11111111:user:U11111111"] } },
      },
    } as OpenClawConfig;
    const unbound = buildPluginRequest({
      turnSourceChannel: "slack",
      policySubject: { pluginKey: "diffs", tool: "diffs" },
    });
    const bound = {
      ...unbound,
      request: { ...unbound.request, turnSourceAccountId: "ops" },
    };
    const canHandle = (accountId: string, request: PluginApprovalRequest) =>
      slackApprovalCapability.nativeRuntime?.availability.shouldHandle({
        cfg,
        accountId,
        approvalKind: "plugin",
        request,
      });
    const targets = (accountId: string, request: PluginApprovalRequest) =>
      slackApprovalCapability.native?.resolveApproverDmTargets?.({
        cfg,
        accountId,
        approvalKind: "plugin",
        request,
      });

    for (const accountId of ["default", "ops"]) {
      expect(canHandle(accountId, unbound)).toBe(false);
      expect(await targets(accountId, unbound)).toEqual([]);
    }
    expect(canHandle("default", bound)).toBe(false);
    expect(canHandle("ops", bound)).toBe(true);
    expect(await targets("default", bound)).toEqual([]);
    expect(await targets("ops", bound)).toEqual([{ to: "team:T11111111:user:U11111111" }]);
  });

  it("routes a policy-only plugin approval to its selected reviewer", async () => {
    installationStates.push(registerSlackInstallationState("default", "workspace", "T11111111"));
    const cfg = {
      channels: { slack: { botToken: "xoxb-default", appToken: "xapp-default" } },
      approvals: {
        plugin: {
          slack: {
            plugins: {
              diffs: {
                tools: { view: { approvers: ["team:T11111111:user:U11111111"] } },
              },
            },
          },
        },
      },
    } as OpenClawConfig;
    const request = buildPluginRequest({
      turnSourceChannel: "slack",
      turnSourceTo: "team:T11111111:channel:C11111111",
      policySubject: { pluginKey: "diffs", tool: "view" },
    });

    expect(
      slackApprovalCapability.nativeRuntime?.availability.shouldHandle({
        cfg,
        accountId: "default",
        approvalKind: "plugin",
        request,
      }),
    ).toBe(true);
    expect(
      await slackApprovalCapability.native?.resolveApproverDmTargets?.({
        cfg,
        accountId: "default",
        approvalKind: "plugin",
        request,
      }),
    ).toEqual([{ to: "team:T11111111:user:U11111111" }]);
  });

  it("does not count another workspace's Slack account as an unbound route candidate", async () => {
    installationStates.push(registerSlackInstallationState("default", "workspace", "T11111111"));
    installationStates.push(registerSlackInstallationState("ops", "workspace", "T22222222"));
    const cfg = {
      channels: {
        slack: {
          accounts: {
            default: { botToken: "xoxb-default", appToken: "xapp-default" },
            ops: { botToken: "xoxb-ops", appToken: "xapp-ops" },
          },
        },
      },
      approvals: {
        plugin: {
          slack: {
            approvers: ["team:T11111111:user:U11111111", "team:T22222222:user:U22222222"],
          },
        },
      },
    } as OpenClawConfig;
    const request = buildPluginRequest({
      turnSourceChannel: "slack",
      turnSourceTo: "team:T11111111:channel:C11111111",
      policySubject: { pluginKey: "diffs", tool: "view" },
    });
    const canHandle = (accountId: string) =>
      slackApprovalCapability.nativeRuntime?.availability.shouldHandle({
        cfg,
        accountId,
        approvalKind: "plugin",
        request,
      });

    expect(canHandle("default")).toBe(true);
    expect(canHandle("ops")).toBe(false);
    expect(
      await slackApprovalCapability.native?.resolveApproverDmTargets?.({
        cfg,
        accountId: "default",
        approvalKind: "plugin",
        request,
      }),
    ).toEqual([{ to: "team:T11111111:user:U11111111" }]);
  });

  it("keeps custody aligned with delivery when another Slack account is disabled", () => {
    installationStates.push(registerSlackInstallationState("default", "workspace", "T11111111"));
    const cfg = {
      channels: {
        slack: {
          accounts: {
            default: { botToken: "xoxb-default", appToken: "xapp-default" },
            dormant: { enabled: false, botToken: "xoxb-dormant", appToken: "xapp-dormant" },
          },
        },
      },
      approvals: {
        plugin: { slack: { approvers: ["team:T11111111:user:U11111111"] } },
      },
    } as OpenClawConfig;
    const request = buildPluginRequest({
      turnSourceChannel: "slack",
      turnSourceTo: "team:T11111111:channel:C11111111",
      policySubject: { pluginKey: "diffs", tool: "diffs" },
    });
    const canHandle = (accountId: string) =>
      slackApprovalCapability.nativeRuntime?.availability.shouldHandle({
        cfg,
        accountId,
        approvalKind: "plugin",
        request,
      });
    const canApprove = (accountId: string) =>
      slackApprovalCapability.authorizeActorAction?.({
        cfg,
        accountId,
        senderId: "team:T11111111:user:U11111111",
        action: "approve",
        approvalKind: "plugin",
        request,
      }).authorized;

    expect(canHandle("default")).toBe(true);
    expect(canHandle("dormant")).toBe(false);
    expect(canApprove("default")).toBe(true);
    expect(canApprove("dormant")).toBe(false);
  });

  it("revokes an old reviewer as soon as the current plugin policy changes", async () => {
    installationStates.push(registerSlackInstallationState("default", "workspace", "T11111111"));
    const request = buildPluginRequest({
      turnSourceChannel: "slack",
      turnSourceTo: "team:T11111111:channel:C11111111",
      policySubject: { pluginKey: "diffs", tool: "view" },
    });
    const config = (reviewer: string): OpenClawConfig => ({
      channels: { slack: { botToken: "xoxb-default", appToken: "xapp-default" } },
      approvals: { plugin: { slack: { approvers: [reviewer] } } },
    });
    const oldReviewer = "team:T11111111:user:U11111111";
    const newReviewer = "team:T11111111:user:U22222222";
    const canApprove = (cfg: OpenClawConfig, senderId: string) =>
      slackApprovalCapability.authorizeActorAction?.({
        cfg,
        accountId: "default",
        senderId,
        action: "approve",
        approvalKind: "plugin",
        request,
      }).authorized;

    expect(canApprove(config(oldReviewer), oldReviewer)).toBe(true);
    const publishedConfig = config(newReviewer);
    expect(canApprove(publishedConfig, oldReviewer)).toBe(false);
    expect(canApprove(publishedConfig, newReviewer)).toBe(true);
    expect(
      await slackApprovalCapability.native?.resolveApproverDmTargets?.({
        cfg: publishedConfig,
        accountId: "default",
        approvalKind: "plugin",
        request,
      }),
    ).toEqual([{ to: newReviewer }]);
  });

  it("routes scoped reviewers only while their Slack installation has authenticated identity", async () => {
    const cfg = {
      channels: { slack: { botToken: "xoxb-default", appToken: "xapp-default" } },
      approvals: {
        plugin: { slack: { approvers: ["team:T11111111:user:U11111111"] } },
      },
    } as OpenClawConfig;
    const request = buildPluginRequest({
      turnSourceChannel: "slack",
      turnSourceTo: "team:T11111111:channel:C11111111",
      policySubject: { pluginKey: "diffs", tool: "view" },
    });
    const params = { cfg, accountId: "default", approvalKind: "plugin" as const, request };
    const state = async () => ({
      route: slackApprovalCapability.nativeRuntime?.availability.shouldHandle(params),
      delivery: slackApprovalCapability.native?.describeDeliveryCapabilities(params).enabled,
      targets: await slackApprovalCapability.native?.resolveApproverDmTargets?.(params),
      authorized: slackApprovalCapability.authorizeActorAction?.({
        ...params,
        senderId: "team:T11111111:user:U11111111",
        action: "approve",
      }).authorized,
    });
    const unavailable = { route: false, delivery: false, targets: [], authorized: false };

    expect(await state()).toEqual(unavailable);
    const degraded = registerSlackInstallationState("default", "degraded");
    installationStates.push(degraded);
    expect(await state()).toEqual(unavailable);
    degraded.release();
    const installation = registerSlackInstallationState("default", "workspace", "T11111111");
    installationStates.push(installation);
    expect(await state()).toEqual({
      route: true,
      delivery: true,
      targets: [{ to: "team:T11111111:user:U11111111" }],
      authorized: true,
    });
    installation.release();
    expect(await state()).toEqual(unavailable);
    installationStates.push(registerSlackInstallationState("default", "workspace", "T22222222"));
    expect(await state()).toEqual(unavailable);
  });

  it("uses the authenticated bot workspace for reviewers on a workspace install", async () => {
    const installation = registerSlackInstallationState("default", "workspace", "T11111111");
    installationStates.push(installation);
    const cfg = {
      ...buildConfig({ allowFrom: ["U999LEGACY"] }),
      approvals: {
        plugin: {
          slack: { approvers: ["team:T11111111:user:U111REVIEWER"] },
        },
      },
    } as OpenClawConfig;
    const request = buildPluginRequest({
      turnSourceChannel: "slack",
      turnSourceTo: "channel:C11111111",
      turnSourceAccountId: "default",
    });
    const dmTargets = () =>
      slackApprovalCapability.native?.resolveApproverDmTargets?.({
        cfg,
        accountId: "default",
        approvalKind: "plugin",
        request,
      });

    expect(await dmTargets()).toEqual([{ to: "team:T11111111:user:U111REVIEWER" }]);
    installation.update("workspace", "T22222222");
    expect(await dmTargets()).toEqual([]);
    expect(
      await slackApprovalCapability.native?.resolveApproverDmTargets?.({
        cfg,
        accountId: "default",
        approvalKind: "plugin",
        request: {
          ...request,
          request: { ...request.request, turnSourceTo: "team:T11111111:channel:C11111111" },
        },
      }),
    ).toEqual([]);
  });
});
