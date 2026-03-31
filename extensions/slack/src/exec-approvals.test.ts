import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it } from "vitest";
import {
  getSlackExecApprovalApprovers,
  isSlackExecApprovalApprover,
  isSlackExecApprovalAuthorizedSender,
  isSlackExecApprovalClientEnabled,
  isSlackExecApprovalTargetRecipient,
  resolveSlackExecApprovalTarget,
  shouldSuppressLocalSlackExecApprovalPrompt,
} from "./exec-approvals.js";

function buildConfig(
  execApprovals?: NonNullable<NonNullable<OpenClawConfig["channels"]>["slack"]>["execApprovals"],
  channelOverrides?: Partial<NonNullable<NonNullable<OpenClawConfig["channels"]>["slack"]>>,
): OpenClawConfig {
  return {
    channels: {
      slack: {
        botToken: "xoxb-test",
        appToken: "xapp-test",
        ...channelOverrides,
        execApprovals,
      },
    },
  } as OpenClawConfig;
}

describe("slack exec approvals", () => {
  it("requires enablement and an explicit or inferred approver", () => {
    expect(isSlackExecApprovalClientEnabled({ cfg: buildConfig() })).toBe(false);
    expect(isSlackExecApprovalClientEnabled({ cfg: buildConfig({ enabled: true }) })).toBe(false);
    expect(
      isSlackExecApprovalClientEnabled({
        cfg: buildConfig({ enabled: true }, { allowFrom: ["U123"] }),
      }),
    ).toBe(true);
    expect(
      isSlackExecApprovalClientEnabled({
        cfg: buildConfig({ enabled: true, approvers: ["U123"] }),
      }),
    ).toBe(true);
  });

  it("prefers explicit approvers when configured", () => {
    const cfg = buildConfig(
      { enabled: true, approvers: ["U456"] },
      { allowFrom: ["U123"], defaultTo: "user:U789" },
    );

    expect(getSlackExecApprovalApprovers({ cfg })).toEqual(["U456"]);
    expect(isSlackExecApprovalApprover({ cfg, senderId: "U456" })).toBe(true);
    expect(isSlackExecApprovalApprover({ cfg, senderId: "U123" })).toBe(false);
  });

  it("infers approvers from allowFrom, dm.allowFrom, and DM defaultTo", () => {
    const cfg = buildConfig(
      { enabled: true },
      {
        allowFrom: ["slack:U123"],
        dm: { allowFrom: ["<@U456>"] },
        defaultTo: "user:U789",
      },
    );

    expect(getSlackExecApprovalApprovers({ cfg })).toEqual(["U123", "U456", "U789"]);
    expect(isSlackExecApprovalApprover({ cfg, senderId: "U789" })).toBe(true);
  });

  it("ignores non-user default targets when inferring approvers", () => {
    const cfg = buildConfig(
      { enabled: true },
      {
        defaultTo: "channel:C123",
      },
    );

    expect(getSlackExecApprovalApprovers({ cfg })).toEqual([]);
  });

  it("defaults target to dm", () => {
    expect(resolveSlackExecApprovalTarget({ cfg: buildConfig({ enabled: true, approvers: ["U1"] }) })).toBe("dm");
  });

  it("matches slack target recipients from generic approval forwarding targets", () => {
    const cfg = {
      channels: {
        slack: {
          botToken: "xoxb-test",
          appToken: "xapp-test",
        },
      },
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [
            { channel: "slack", to: "user:U123TARGET" },
            { channel: "slack", to: "channel:C123" },
          ],
        },
      },
    } as OpenClawConfig;

    expect(isSlackExecApprovalTargetRecipient({ cfg, senderId: "U123TARGET" })).toBe(true);
    expect(isSlackExecApprovalTargetRecipient({ cfg, senderId: "U999OTHER" })).toBe(false);
    expect(isSlackExecApprovalAuthorizedSender({ cfg, senderId: "U123TARGET" })).toBe(true);
  });

  it("suppresses local prompts only when slack native exec approvals are enabled", () => {
    const payload = {
      channelData: {
        execApproval: {
          approvalId: "req-1",
          approvalSlug: "req-1",
        },
      },
    };

    expect(
      shouldSuppressLocalSlackExecApprovalPrompt({
        cfg: buildConfig({ enabled: true, approvers: ["U123"] }),
        payload,
      }),
    ).toBe(true);

    expect(
      shouldSuppressLocalSlackExecApprovalPrompt({
        cfg: buildConfig(),
        payload,
      }),
    ).toBe(false);
  });
});
