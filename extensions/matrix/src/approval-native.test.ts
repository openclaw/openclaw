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

function authorize(cfg: OpenClawConfig, senderId: string, approvalKind: "plugin" | "exec") {
  return matrixApprovalCapability.authorizeActorActionAsync?.({
    accountId: "default",
    cfg,
    senderId,
    action: "approve",
    approvalKind,
  });
}

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
    const targets = await matrixApprovalCapability.nativeAsync?.resolveApproverDmTargets?.({
      cfg: buildConfig(),
      accountId: "default",
      approvalKind: "exec",
      request: {
        id: "req-1",
        request: { command: "echo hi" },
        createdAtMs: 0,
        expiresAtMs: 1000,
      },
    });

    expect(targets).toEqual([{ to: "user:@owner:example.org" }]);
  });

  it("keeps plugin approval auth independent from exec approvers", async () => {
    const cfg = buildConfig({
      dm: { allowFrom: ["@owner:example.org"] },
      execApprovals: { enabled: true, approvers: ["@exec:example.org"], target: "both" },
    });

    expect(await authorize(cfg, "@owner:example.org", "plugin")).toEqual({ authorized: true });

    expect(await authorize(cfg, "@exec:example.org", "plugin")).toEqual({
      authorized: false,
      reason: "❌ You are not authorized to approve plugin requests on Matrix.",
    });

    expect(await authorize(cfg, "@exec:example.org", "exec")).toEqual({ authorized: true });
  });

  it("requires exact Matrix identities for native approval actions", async () => {
    const cfg = buildConfig({
      dm: { allowFrom: ["@\u212A:example.org"] },
      execApprovals: { enabled: true, approvers: ["@\u212A:example.org"], target: "both" },
    });

    for (const approvalKind of ["plugin", "exec"] as const) {
      expect(await authorize(cfg, "@\u212A:example.org", approvalKind)).toEqual({
        authorized: true,
      });
      expect(await authorize(cfg, "@k:example.org", approvalKind)).toEqual({
        authorized: false,
        reason: `\u274c You are not authorized to approve ${approvalKind} requests on Matrix.`,
      });
    }
  });

  it("requires Matrix DM approvers before enabling plugin approval auth", async () => {
    const cfg = buildConfig({
      dm: { allowFrom: [] },
      execApprovals: { enabled: true, approvers: ["@exec:example.org"], target: "both" },
    });

    expect(await authorize(cfg, "@exec:example.org", "plugin")).toEqual({
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
        accountId: "default",
        action: "approve",
        approvalKind: "plugin",
      }),
    ).toEqual({ kind: "enabled" });

    expect(
      await matrixApprovalCapability.getExecInitiatingSurfaceStateAsync?.({
        cfg,
        accountId: "default",
        action: "approve",
      }),
    ).toEqual({ kind: "disabled" });
  });

  it("handles opaque-id plugin approvals for plugin-only approvers", async () => {
    const cfg = buildConfig({
      dm: { allowFrom: ["*"] },
      execApprovals: { enabled: true, approvers: [], target: "both" },
    });
    const request = {
      id: "opaque-approval-id",
      request: {
        title: "Plugin Approval Required",
        description: "Allow plugin access",
        pluginId: "git-tools",
        turnSourceChannel: "matrix",
        turnSourceTo: "room:!ops:example.org",
      },
      createdAtMs: 0,
      expiresAtMs: 1000,
    };

    const pluginContext = { cfg, accountId: "default", approvalKind: "plugin" as const, request };
    expect(
      await matrixApprovalCapability.nativeRuntimeAsync?.availability.shouldHandle(pluginContext),
    ).toBe(true);
    expect(
      (await matrixApprovalCapability.nativeAsync?.describeDeliveryCapabilities(pluginContext))
        ?.enabled,
    ).toBe(true);
    expect(
      await matrixApprovalCapability.nativeAsync?.resolveOriginTarget?.(pluginContext),
    ).toEqual({ to: "room:!ops:example.org", threadId: undefined });
    expect(
      await matrixApprovalCapability.nativeAsync?.resolveOriginTarget?.({
        cfg,
        accountId: "default",
        request,
      } as never),
    ).toBeNull();
    expect(
      await matrixApprovalCapability.nativeRuntimeAsync?.availability.shouldHandle({
        cfg: buildConfig(),
        accountId: "default",
        request,
      } as never),
    ).toBe(false);
    expect(
      await matrixApprovalCapability.delivery?.shouldSuppressForwardingFallbackAsync?.({
        cfg,
        approvalKind: "plugin",
        target: { channel: "matrix", to: "room:!ops:example.org", accountId: "default" },
        request,
      } as never),
    ).toBe(true);
    expect(
      await matrixApprovalCapability.nativeRuntimeAsync?.availability.shouldHandle({
        cfg,
        accountId: "default",
        approvalKind: "exec",
        request: {
          id: "opaque-exec-approval-id",
          request: { command: "echo hi" },
          createdAtMs: 0,
          expiresAtMs: 1000,
        },
      }),
    ).toBe(false);
  });

  it("keeps matrix-native plugin approval delivery disabled without DM approvers", async () => {
    const capabilities = await matrixApprovalCapability.nativeAsync?.describeDeliveryCapabilities({
      cfg: buildConfig(),
      accountId: "default",
      approvalKind: "plugin",
      request: {
        id: "plugin:req-1",
        request: {
          title: "Plugin Approval Required",
          description: "Allow plugin access",
          pluginId: "git-tools",
        },
        createdAtMs: 0,
        expiresAtMs: 1000,
      },
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
