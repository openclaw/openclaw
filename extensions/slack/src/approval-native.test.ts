import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it } from "vitest";
import { slackNativeApprovalAdapter } from "./approval-native.js";

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

describe("slack native approval adapter", () => {
  it("describes native slack approval delivery capabilities", () => {
    const capabilities = slackNativeApprovalAdapter.native?.describeDeliveryCapabilities({
      cfg: buildConfig(),
      accountId: "default",
      approvalKind: "exec",
      request: {
        id: "req-1",
        request: {
          command: "echo hi",
          turnSourceChannel: "slack",
          turnSourceTo: "channel:C123",
          turnSourceAccountId: "default",
          sessionKey: "agent:main:slack:channel:c123",
        },
        createdAtMs: 0,
        expiresAtMs: 1000,
      },
    });

    expect(capabilities).toEqual({
      enabled: true,
      preferredSurface: "both",
      supportsOriginSurface: true,
      supportsApproverDmSurface: true,
      notifyOriginWhenDmOnly: true,
    });
  });

  it("resolves origin targets from slack turn source", async () => {
    const target = await slackNativeApprovalAdapter.native?.resolveOriginTarget?.({
      cfg: buildConfig(),
      accountId: "default",
      approvalKind: "exec",
      request: {
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
      },
    });

    expect(target).toEqual({
      to: "channel:C123",
      threadId: "1712345678.123456",
    });
  });

  it("keeps origin delivery when session and turn source thread ids differ only by Slack timestamp precision", async () => {
    const target = await slackNativeApprovalAdapter.native?.resolveOriginTarget?.({
      cfg: buildConfig(),
      accountId: "default",
      approvalKind: "exec",
      request: {
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
      },
    });

    expect(target).toEqual({
      to: "channel:C123",
      threadId: "1712345678.123456",
    });
  });

  it("resolves approver dm targets", async () => {
    const targets = await slackNativeApprovalAdapter.native?.resolveApproverDmTargets?.({
      cfg: buildConfig(),
      accountId: "default",
      approvalKind: "exec",
      request: {
        id: "req-1",
        request: {
          command: "echo hi",
        },
        createdAtMs: 0,
        expiresAtMs: 1000,
      },
    });

    expect(targets).toEqual([{ to: "user:U123APPROVER" }]);
  });

  it("skips native delivery when agent filters do not match", async () => {
    const cfg = buildConfig({
      execApprovals: {
        enabled: true,
        approvers: ["U123APPROVER"],
        target: "both",
        agentFilter: ["ops-agent"],
      },
    });

    const originTarget = await slackNativeApprovalAdapter.native?.resolveOriginTarget?.({
      cfg,
      accountId: "default",
      approvalKind: "exec",
      request: {
        id: "req-1",
        request: {
          command: "echo hi",
          agentId: "other-agent",
          turnSourceChannel: "slack",
          turnSourceTo: "channel:C123",
          turnSourceAccountId: "default",
          sessionKey: "agent:other-agent:slack:channel:c123",
        },
        createdAtMs: 0,
        expiresAtMs: 1000,
      },
    });
    const dmTargets = await slackNativeApprovalAdapter.native?.resolveApproverDmTargets?.({
      cfg,
      accountId: "default",
      approvalKind: "exec",
      request: {
        id: "req-1",
        request: {
          command: "echo hi",
          agentId: "other-agent",
          sessionKey: "agent:other-agent:slack:channel:c123",
        },
        createdAtMs: 0,
        expiresAtMs: 1000,
      },
    });

    expect(originTarget).toBeNull();
    expect(dmTargets).toEqual([]);
  });

  it("suppresses generic slack fallback only for slack-originated approvals", () => {
    const shouldSuppress = slackNativeApprovalAdapter.delivery.shouldSuppressForwardingFallback;
    if (!shouldSuppress) {
      throw new Error("slack native delivery suppression unavailable");
    }

    expect(
      shouldSuppress({
        cfg: buildConfig(),
        target: { channel: "slack", accountId: "default" },
        request: {
          request: {
            turnSourceChannel: "slack",
            turnSourceAccountId: "default",
          },
        },
      }),
    ).toBe(true);

    expect(
      shouldSuppress({
        cfg: buildConfig(),
        target: { channel: "slack", accountId: "default" },
        request: {
          request: {
            turnSourceChannel: "discord",
            turnSourceAccountId: "default",
          },
        },
      }),
    ).toBe(false);
  });
});
