import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it } from "vitest";
import { matrixApprovalCapability, matrixNativeApprovalAdapter } from "./approval-native.js";

function buildConfig(
  overrides?: Partial<NonNullable<NonNullable<OpenClawConfig["channels"]>["matrix"]>>,
): OpenClawConfig {
  return {
    channels: {
      matrix: {
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "tok",
        execApprovals: {
          enabled: true,
          approvers: ["@owner:example.org"],
          target: "both",
        },
        ...overrides,
      },
    },
  } as OpenClawConfig;
}

describe("matrix native approval adapter", () => {
  it("describes native matrix approval delivery capabilities", () => {
    const capabilities = matrixNativeApprovalAdapter.native?.describeDeliveryCapabilities({
      cfg: buildConfig(),
      accountId: "default",
      approvalKind: "exec",
      request: {
        id: "req-1",
        request: {
          command: "echo hi",
          turnSourceChannel: "matrix",
          turnSourceTo: "room:!ops:example.org",
          turnSourceAccountId: "default",
          sessionKey: "agent:main:matrix:channel:!ops:example.org",
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
      notifyOriginWhenDmOnly: false,
    });
  });

  it("resolves origin targets from matrix turn source", async () => {
    const target = await matrixNativeApprovalAdapter.native?.resolveOriginTarget?.({
      cfg: buildConfig(),
      accountId: "default",
      approvalKind: "exec",
      request: {
        id: "req-1",
        request: {
          command: "echo hi",
          turnSourceChannel: "matrix",
          turnSourceTo: "room:!ops:example.org",
          turnSourceThreadId: "$thread",
          turnSourceAccountId: "default",
          sessionKey: "agent:main:matrix:channel:!ops:example.org",
        },
        createdAtMs: 0,
        expiresAtMs: 1000,
      },
    });

    expect(target).toEqual({
      to: "room:!ops:example.org",
      threadId: "$thread",
    });
  });

  it("resolves approver dm targets", async () => {
    const targets = await matrixNativeApprovalAdapter.native?.resolveApproverDmTargets?.({
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

    expect(targets).toEqual([{ to: "user:@owner:example.org" }]);
  });

  it("keeps plugin approval auth independent from exec approvers", () => {
    const cfg = buildConfig({
      dm: { allowFrom: ["@owner:example.org"] },
      execApprovals: {
        enabled: true,
        approvers: ["@exec:example.org"],
        target: "both",
      },
    });

    expect(
      matrixApprovalCapability.authorizeActorAction?.({
        cfg,
        accountId: "default",
        senderId: "@owner:example.org",
        action: "approve",
        approvalKind: "plugin",
      }),
    ).toEqual({ authorized: true });

    expect(
      matrixApprovalCapability.authorizeActorAction?.({
        cfg,
        accountId: "default",
        senderId: "@exec:example.org",
        action: "approve",
        approvalKind: "plugin",
      }),
    ).toEqual({
      authorized: false,
      reason: "❌ You are not authorized to approve plugin requests on Matrix.",
    });

    expect(
      matrixApprovalCapability.authorizeActorAction?.({
        cfg,
        accountId: "default",
        senderId: "@exec:example.org",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ authorized: true });
  });
});
