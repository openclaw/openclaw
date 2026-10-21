import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { matrixApprovalCapability } from "./approval-native.js";

function buildConfig(
  overrides?: Partial<NonNullable<NonNullable<OpenClawConfig["channels"]>["matrix"]>>,
): OpenClawConfig {
  return {
    channels: {
      matrix: {
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "tok",
        execApprovals: { enabled: true, approvers: ["@owner:example.org"], target: "both" },
        ...overrides,
      },
    },
  } as OpenClawConfig;
}

const context = { accountId: "default", action: "approve" as const };
const execRequest = {
  id: "opaque-exec-approval-id",
  request: { command: "echo hi" },
  createdAtMs: 0,
  expiresAtMs: 1000,
};
const pluginRequest = {
  ...execRequest,
  id: "opaque-approval-id",
  request: {
    title: "Plugin Approval Required",
    description: "Allow plugin access",
    pluginId: "git-tools",
    turnSourceChannel: "matrix",
    turnSourceTo: "room:!ops:example.org",
  },
};
const { nativeAsync: native, nativeRuntimeAsync: runtime, delivery } = matrixApprovalCapability;

describe("matrix approval capability", () => {
  it.each([undefined, "work"])("describes the Matrix setup path for account %s", (accountId) => {
    const text = matrixApprovalCapability.describeExecApprovalSetup?.({
      channel: "matrix",
      channelLabel: "Matrix",
      accountId,
    });
    const prefix = accountId ? "channels.matrix.accounts.work" : "channels.matrix";
    expect(text).toContain("`" + prefix + ".execApprovals.approvers`");
    expect(text).toContain("`" + prefix + ".dm.allowFrom`");
    if (accountId) {
      expect(text).not.toContain("`channels.matrix.execApprovals.approvers`");
    } else {
      expect(text).toContain("Approve it from the Web UI for now.");
      expect(text).not.toMatch(/terminal UI|\bTUI\b/i);
    }
  });

  it("resolves approver dm targets", async () => {
    const targets = await native?.resolveApproverDmTargets?.({
      cfg: buildConfig(),
      accountId: "default",
      approvalKind: "exec",
      request: execRequest,
    });

    expect(targets).toEqual([{ to: "user:@owner:example.org" }]);
  });

  it("requires Matrix DM approvers before enabling plugin approval auth", async () => {
    const cfg = buildConfig({
      dm: { allowFrom: [] },
      execApprovals: { enabled: true, approvers: ["@exec:example.org"], target: "both" },
    });

    expect(
      await matrixApprovalCapability.authorizeActorActionAsync?.({
        ...context,
        cfg,
        senderId: "@exec:example.org",
        approvalKind: "plugin",
      }),
    ).toEqual({
      authorized: false,
      reason: "❌ Matrix plugin approvals are not enabled for this bot account.",
    });
  });

  it("reports exec initiating-surface availability independently from plugin auth", async () => {
    const cfg = buildConfig({
      dm: { allowFrom: ["@owner:example.org"] },
      execApprovals: { enabled: false, approvers: [], target: "both" },
    });

    expect(
      matrixApprovalCapability.getActionAvailabilityState?.({
        cfg,
        ...context,
        approvalKind: "plugin",
      }),
    ).toEqual({ kind: "enabled" });

    expect(
      await matrixApprovalCapability.getExecInitiatingSurfaceStateAsync?.({
        cfg,
        ...context,
      }),
    ).toEqual({ kind: "disabled" });
  });

  it("handles opaque-id plugin approvals for plugin-only approvers", async () => {
    const cfg = buildConfig({
      dm: { allowFrom: ["*"] },
      execApprovals: { enabled: true, approvers: [], target: "both" },
    });
    const request = pluginRequest;
    const pluginContext = { ...context, cfg, approvalKind: "plugin" as const, request };
    expect(await runtime?.availability.shouldHandle(pluginContext)).toBe(true);
    expect((await native?.describeDeliveryCapabilities(pluginContext))?.enabled).toBe(true);
    expect(await native?.resolveOriginTarget?.(pluginContext)).toEqual({
      to: "room:!ops:example.org",
      threadId: undefined,
    });
    expect(
      await native?.resolveOriginTarget?.({
        cfg,
        accountId: "default",
        request,
      } as never),
    ).toBeNull();
    expect(
      await runtime?.availability.shouldHandle({
        cfg: buildConfig(),
        accountId: "default",
        request,
      } as never),
    ).toBe(false);
    expect(
      await delivery?.shouldSuppressForwardingFallbackAsync?.({
        cfg,
        approvalKind: "plugin",
        target: { channel: "matrix", to: "room:!ops:example.org", accountId: "default" },
        request,
      } as never),
    ).toBe(true);
    expect(
      await runtime?.availability.shouldHandle({
        cfg,
        accountId: "default",
        approvalKind: "exec",
        request: execRequest,
      }),
    ).toBe(false);
  });

  it("keeps matrix-native plugin approval delivery disabled without DM approvers", async () => {
    const capabilities = await native?.describeDeliveryCapabilities({
      cfg: buildConfig(),
      accountId: "default",
      approvalKind: "plugin",
      request: pluginRequest,
    });

    expect(capabilities).toEqual({
      enabled: false,
      preferredSurface: "both",
      supportsOriginSurface: true,
      supportsApproverDmSurface: true,
      notifyOriginWhenDmOnly: true,
    });
  });
});
