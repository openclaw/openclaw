import { createNativeApprovalTestFixture } from "openclaw/plugin-sdk/channel-test-helpers";
import { describe, expect, it } from "vitest";
import { whatsappApprovalCapability } from "./approval-native.js";

const fixture = createNativeApprovalTestFixture({
  channel: "whatsapp",
  capability: whatsappApprovalCapability,
  buildConfig: ({ channel, approvals } = {}) => ({
    channels: { whatsapp: { enabled: true, ...channel } },
    approvals,
  }),
});
const { buildConfig, buildExecRequest, checks } = fixture;

describe("whatsapp approval capability", () => {
  it("uses target-mode config for requestless availability without native runtime handling", () =>
    checks.targetMode());

  it(
    "suppresses both-mode unscoped targets through the configured default WhatsApp account",
    checks.defaultAccountBothTarget,
  );

  it("allows group-origin emoji approvals only after exec forwarding and approvers are configured", () => {
    const request = buildExecRequest("120363401234567890@g.us");
    const withoutApprovers = buildConfig({ approvals: { exec: { enabled: true } } });
    const withApprovers = buildConfig({
      channel: { allowFrom: ["+15551230000"] },
      approvals: { exec: { enabled: true } },
    });

    expect(
      whatsappApprovalCapability.native?.resolveOriginTarget?.({
        cfg: withoutApprovers,
        accountId: "default",
        approvalKind: "exec",
        request,
      }),
    ).toBeNull();
    expect(
      whatsappApprovalCapability.native?.resolveOriginTarget?.({
        cfg: withApprovers,
        accountId: "default",
        approvalKind: "exec",
        request,
      }),
    ).toEqual({
      to: "120363401234567890@g.us",
      accountId: "default",
    });
  });
});
