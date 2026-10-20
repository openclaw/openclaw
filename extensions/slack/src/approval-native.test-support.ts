import type { PluginApprovalRequest } from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

export function buildConfig(
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

export function buildPluginRequest(
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

export function createExecApprovalRequest() {
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
