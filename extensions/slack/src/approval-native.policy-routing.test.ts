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

function createExecApprovalRequest() {
  return {
    id: "req-1",
    request: {
      command: "echo hi",
      turnSourceChannel: "slack",
      turnSourceTo: "channel:C123",
      turnSourceAccountId: "default",
      turnSourceThreadId: "1712345678.123456",
      sessionKey: "agent:main:slack:channel:c123:thread:1712345678.123456",
    },
    createdAtMs: 0,
    expiresAtMs: 1000,
  };
}

describe("Slack plugin approval reviewer routing policy", () => {
  it("delivers only to the request's configured workspace-qualified tool reviewers", async () => {
    installationStates.push(registerSlackInstallationState("default", "workspace", "T11111111"));
    const cfg: OpenClawConfig = {
      ...buildConfig({ allowFrom: ["U999LEGACY"] }),
      approvals: {
        plugin: {
          slack: {
            approvers: [],
            plugins: {
              calendar: {
                approvers: ["team:T11111111:user:U22222222"],
                tools: {
                  create_event: {
                    approvers: ["team:T11111111:user:U33333333"],
                  },
                },
              },
            },
          },
        },
      },
    };
    const request = buildPluginRequest({
      turnSourceChannel: "slack",
      turnSourceAccountId: "default",
      turnSourceTo: "team:T11111111:channel:C11111111",
      policySubject: {
        pluginKey: "calendar",
        tool: "create_event",
      },
    });
    const dmTargets = (pending: PluginApprovalRequest) =>
      slackApprovalCapability.native?.resolveApproverDmTargets?.({
        cfg,
        accountId: "default",
        approvalKind: "plugin",
        request: pending,
      });

    expect(dmTargets(request)).toEqual([{ to: "team:T11111111:user:U33333333" }]);
    expect(
      dmTargets({
        ...request,
        request: { ...request.request, policySubject: { pluginKey: "calendar" } },
      }),
    ).toEqual([]);
    expect(
      dmTargets({
        ...request,
        request: { ...request.request, turnSourceTo: "team:T22222222:channel:C22222222" },
      }),
    ).toEqual([]);
  });

  it("checks the selected plugin tool policy before advertising a turn-source route", () => {
    installationStates.push(registerSlackInstallationState("default", "workspace", "T11111111"));
    const cfg = {
      ...buildConfig({ allowFrom: ["U11111111"] }),
      approvals: {
        plugin: {
          slack: {
            approvers: [],
            plugins: {
              diffs: {
                tools: { diffs: { approvers: ["team:T11111111:user:U11111111"] } },
              },
            },
          },
        },
      },
    } as OpenClawConfig;
    const availability = (request?: PluginApprovalRequest, config = cfg) =>
      slackApprovalCapability.getActionAvailabilityState?.({
        cfg: config,
        accountId: "default",
        action: "approve",
        approvalKind: "plugin",
        ...(request ? { request } : {}),
      });

    expect(
      availability(buildPluginRequest({ policySubject: { pluginKey: "diffs", tool: "diffs" } })),
    ).toEqual({
      kind: "enabled",
    });
    expect(
      availability(buildPluginRequest({ policySubject: { pluginKey: "diffs", tool: "other" } })),
    ).toEqual({
      kind: "disabled",
    });
    expect(
      availability(
        buildPluginRequest({
          policySubject: { pluginKey: "diffs", tool: "diffs" },
          turnSourceChannel: "slack",
          turnSourceTo: "team:T22222222:channel:C22222222",
        }),
      ),
    ).toEqual({ kind: "disabled" });
    expect(
      availability(buildPluginRequest({ policySubject: { pluginKey: "diffs", tool: "diffs" } }), {
        ...cfg,
        channels: { slack: { ...cfg.channels?.slack, botToken: "" } },
      }),
    ).toEqual({ kind: "disabled" });
    expect(
      availability(buildPluginRequest(), {
        ...cfg,
        approvals: { plugin: { slack: { approvers: [] } } },
      }),
    ).toEqual({ kind: "disabled" });
  });

  it("retains legacy approval availability when another plugin alone has Slack reviewers", () => {
    const cfg = {
      ...buildConfig({
        allowFrom: ["U11111111"],
        execApprovals: { enabled: false, approvers: ["U11111111"], target: "dm" },
      }),
      approvals: {
        plugin: {
          slack: {
            plugins: { calendar: { approvers: ["team:T11111111:user:U22222222"] } },
          },
        },
      },
    } as OpenClawConfig;
    const request = buildPluginRequest({
      turnSourceChannel: "slack",
      turnSourceAccountId: "default",
      turnSourceTo: "team:T11111111:channel:C11111111",
      policySubject: { pluginKey: "diffs", tool: "diffs" },
    });

    expect(
      slackApprovalCapability.getActionAvailabilityState?.({
        cfg,
        accountId: "default",
        action: "approve",
        approvalKind: "plugin",
        request,
      }),
    ).toEqual({ kind: "enabled" });
    expect(
      slackApprovalCapability.nativeRuntime?.availability.shouldHandle({
        cfg,
        accountId: "default",
        approvalKind: "plugin",
        request,
      }),
    ).toBe(false);
  });

  it("activates plugin delivery from an explicit reviewer list without exec or forwarding config", async () => {
    installationStates.push(registerSlackInstallationState("default", "workspace", "T11111111"));
    const cfg = {
      channels: { slack: { botToken: "xoxb-test", appToken: "xapp-test" } },
      approvals: {
        plugin: { slack: { approvers: ["team:T11111111:user:U111REVIEWER"] } },
      },
    } as OpenClawConfig;
    const request = buildPluginRequest({
      turnSourceChannel: "slack",
      turnSourceTo: "channel:C11111111",
      turnSourceAccountId: "default",
    });

    expect(
      slackApprovalCapability.nativeRuntime?.availability.isConfigured({
        cfg,
        accountId: "default",
      }),
    ).toBe(true);
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
    ).toEqual([{ to: "team:T11111111:user:U111REVIEWER" }]);
    expect(
      slackApprovalCapability.native?.describeDeliveryCapabilities({
        cfg,
        accountId: "default",
        approvalKind: "exec",
        request: createExecApprovalRequest(),
      }).enabled,
    ).toBe(false);
  });

  it("routes a selected reviewer policy to DMs even when plugin forwarding uses the session", () => {
    installationStates.push(registerSlackInstallationState("default", "workspace", "T11111111"));
    const cfg = {
      ...buildConfig({
        execApprovals: { enabled: false, target: "channel" },
      }),
      approvals: {
        plugin: {
          enabled: true,
          mode: "session",
          slack: { approvers: ["team:T11111111:user:U111REVIEWER"] },
        },
      },
    } as OpenClawConfig;
    const request = buildPluginRequest({
      turnSourceChannel: "slack",
      turnSourceTo: "team:T11111111:channel:C11111111",
      turnSourceAccountId: "default",
      sessionKey: "slack:channel:C11111111:test-run",
    });

    expect(
      slackApprovalCapability.native?.describeDeliveryCapabilities({
        cfg,
        accountId: "default",
        approvalKind: "plugin",
        request,
      }),
    ).toMatchObject({
      enabled: true,
      preferredSurface: "approver-dm",
      supportsApproverDmSurface: true,
      notifyOriginWhenDmOnly: true,
    });
  });

  it("blocks a selected empty reviewer policy even without a native Slack handler", () => {
    const shouldBlock = slackApprovalCapability.delivery?.shouldBlockForwardingFallback;
    if (!shouldBlock) {
      throw new Error("Slack plugin reviewer fallback policy unavailable");
    }
    const cfg = {
      ...buildConfig(),
      approvals: {
        plugin: { slack: { plugins: { sage: { approvers: [] } } } },
      },
    } as OpenClawConfig;
    const input = {
      cfg,
      approvalKind: "plugin" as const,
      target: { channel: "slack", to: "user:U123OWNER", accountId: "default" },
    };

    expect(
      shouldBlock({
        ...input,
        request: buildPluginRequest({ policySubject: { pluginKey: "sage" } }),
      }),
    ).toBe(true);
    expect(
      shouldBlock({
        ...input,
        request: buildPluginRequest({ policySubject: { pluginKey: "other" } }),
      }),
    ).toBe(false);
  });

  it("keeps selected reviewer cards on the native DM route", () => {
    installationStates.push(registerSlackInstallationState("default", "workspace", "T11111111"));
    const shouldBlock = slackApprovalCapability.delivery?.shouldBlockForwardingFallback;
    if (!shouldBlock) {
      throw new Error("Slack plugin reviewer fallback policy unavailable");
    }
    const cfg = {
      ...buildConfig(),
      approvals: { plugin: { slack: { approvers: ["team:T11111111:user:U11111111"] } } },
    } as OpenClawConfig;
    const request = buildPluginRequest({
      turnSourceChannel: "slack",
      turnSourceTo: "team:T11111111:channel:C11111111",
      turnSourceAccountId: "default",
    });
    const target = { channel: "slack", to: "user:U11111111", accountId: "default" };

    expect(shouldBlock({ cfg, approvalKind: "plugin", target, request })).toBe(true);
    expect(
      shouldBlock({
        cfg,
        approvalKind: "plugin",
        target: { ...target, to: "user:U22222222" },
        request,
      }),
    ).toBe(true);
  });

  it("blocks Slack forwarding when the request has no authorized Slack reviewers", () => {
    const shouldBlock = slackApprovalCapability.delivery?.shouldBlockForwardingFallback;
    if (!shouldBlock) {
      throw new Error("Slack plugin reviewer fallback policy unavailable");
    }
    const request = buildPluginRequest({ turnSourceChannel: "slack" });
    const input = {
      approvalKind: "plugin" as const,
      target: { channel: "slack", to: "channel:C123ROOM", accountId: "default" },
      request,
    };

    expect(
      shouldBlock({
        ...input,
        cfg: {
          ...buildConfig({ allowFrom: ["U123OWNER"] }),
          approvals: { plugin: { slack: { approvers: [] } } },
        },
      }),
    ).toBe(true);
    expect(
      shouldBlock({
        ...input,
        cfg: {
          ...buildConfig({ allowFrom: ["U123OWNER"] }),
          approvals: {
            plugin: {
              slack: {
                plugins: {
                  diffs: { tools: { diffs: { approvers: ["team:T123:user:U123OWNER"] } } },
                },
              },
            },
          },
        },
      }),
    ).toBe(true);
    expect(
      shouldBlock({
        ...input,
        request: buildPluginRequest({
          turnSourceChannel: "slack",
          turnSourceTo: "team:T22222222:channel:C22222222",
          policySubject: { pluginKey: "diffs", tool: "diffs" },
        }),
        cfg: {
          ...buildConfig({ allowFrom: ["U123OWNER"] }),
          approvals: {
            plugin: {
              slack: {
                plugins: {
                  diffs: {
                    tools: { diffs: { approvers: ["team:T11111111:user:U123OWNER"] } },
                  },
                },
              },
            },
          },
        },
      }),
    ).toBe(true);
  });
});
