import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { whatsappApprovalCapability } from "./approval-native.js";

function buildConfig(
  overrides?: Partial<NonNullable<NonNullable<OpenClawConfig["channels"]>["whatsapp"]>>,
): OpenClawConfig {
  return {
    channels: {
      whatsapp: {
        enabled: true,
        ...overrides,
      },
    },
  } as OpenClawConfig;
}

function buildExecRequest(turnSourceTo: string) {
  return {
    id: "exec-1",
    request: {
      command: "echo hi",
      turnSourceChannel: "whatsapp",
      turnSourceTo,
      turnSourceAccountId: "default",
      sessionKey: `agent:main:whatsapp:${turnSourceTo}`,
    },
    createdAtMs: 0,
    expiresAtMs: 1000,
  };
}

describe("whatsapp approval capability", () => {
  it("keeps implicit same-chat native approval enabled for direct origins", () => {
    const capabilities = whatsappApprovalCapability.native?.describeDeliveryCapabilities({
      cfg: buildConfig(),
      accountId: "default",
      approvalKind: "exec",
      request: buildExecRequest("+15551230000"),
    });

    expect(capabilities).toEqual({
      enabled: true,
      preferredSurface: "origin",
      supportsOriginSurface: true,
      supportsApproverDmSurface: false,
      notifyOriginWhenDmOnly: true,
    });
  });

  it("does not advertise group-origin emoji approvals without explicit approvers", async () => {
    const request = buildExecRequest("120363401234567890@g.us");

    expect(
      whatsappApprovalCapability.native?.resolveOriginTarget?.({
        cfg: buildConfig(),
        accountId: "default",
        approvalKind: "exec",
        request,
      }),
    ).toBeNull();

    expect(
      whatsappApprovalCapability.native?.describeDeliveryCapabilities({
        cfg: buildConfig(),
        accountId: "default",
        approvalKind: "exec",
        request,
      }),
    ).toEqual({
      enabled: false,
      preferredSurface: "approver-dm",
      supportsOriginSurface: false,
      supportsApproverDmSurface: false,
      notifyOriginWhenDmOnly: true,
    });
  });

  it("allows group-origin emoji approvals when explicit approvers are configured", async () => {
    const request = buildExecRequest("120363401234567890@g.us");
    const cfg = buildConfig({ allowFrom: ["+15551230000"] });

    expect(
      whatsappApprovalCapability.native?.resolveOriginTarget?.({
        cfg,
        accountId: "default",
        approvalKind: "exec",
        request,
      }),
    ).toEqual({
      to: "120363401234567890@g.us",
      accountId: "default",
    });

    expect(
      whatsappApprovalCapability.native?.describeDeliveryCapabilities({
        cfg,
        accountId: "default",
        approvalKind: "exec",
        request,
      }),
    ).toEqual({
      enabled: true,
      preferredSurface: "origin",
      supportsOriginSurface: true,
      supportsApproverDmSurface: true,
      notifyOriginWhenDmOnly: true,
    });
  });
});
