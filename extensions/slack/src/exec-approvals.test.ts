// Slack tests cover exec approvals plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { slackApprovalCapability } from "./approval-native.js";
import { slackChannelConfigUiHints } from "./config-ui-hints.js";
import {
  getSlackExecApprovalApprovers,
  isSlackExecApprovalAuthorizedSender,
  isSlackExecApprovalClientEnabled,
  normalizeSlackApproverId,
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
  it("requires explicit enablement even when owner approvers resolve", () => {
    expect(isSlackExecApprovalClientEnabled({ cfg: buildConfig() })).toBe(false);
    expect(
      isSlackExecApprovalClientEnabled({
        cfg: buildConfig({ enabled: true }),
      }),
    ).toBe(false);
    expect(
      isSlackExecApprovalClientEnabled({
        cfg: buildConfig({ approvers: ["U123"] }),
      }),
    ).toBe(false);
    expect(
      isSlackExecApprovalClientEnabled({
        cfg: {
          ...buildConfig(),
          commands: { ownerAllowFrom: ["slack:U123OWNER"] },
        } as OpenClawConfig,
      }),
    ).toBe(false);
    expect(
      isSlackExecApprovalClientEnabled({
        cfg: buildConfig({ enabled: "auto", approvers: ["U123"] }),
      }),
    ).toBe(true);
    expect(
      isSlackExecApprovalClientEnabled({
        cfg: buildConfig({ enabled: false, approvers: ["U123"] }),
      }),
    ).toBe(false);
  });

  it.each(["execApprovals", "execApprovals.enabled"] as const)(
    "describes the explicit enablement and approver requirements in %s UI guidance",
    (key) => {
      const { help } = slackChannelConfigUiHints[key];
      expect(help).toContain('"auto" or true');
      expect(help).toContain("when approvers can be resolved");
      expect(help).toContain("unset or false disables");
    },
  );

  it("prefers explicit approvers when configured", () => {
    const cfg = buildConfig(
      { approvers: ["U456"] },
      { allowFrom: ["U123"], defaultTo: "user:U789" },
    );

    expect(getSlackExecApprovalApprovers({ cfg })).toEqual(["U456"]);
    expect(isSlackExecApprovalAuthorizedSender({ cfg, senderId: "U456" })).toBe(true);
    expect(isSlackExecApprovalAuthorizedSender({ cfg, senderId: "u456" })).toBe(true);
    expect(isSlackExecApprovalAuthorizedSender({ cfg, senderId: "U123" })).toBe(false);
  });

  it("canonicalizes configured exec approver ids before matching uppercase senders", () => {
    const explicitCfg = buildConfig({ approvers: ["u456"] });
    expect(getSlackExecApprovalApprovers({ cfg: explicitCfg })).toEqual(["U456"]);
    expect(isSlackExecApprovalAuthorizedSender({ cfg: explicitCfg, senderId: "U456" })).toBe(true);

    const ownerFallbackCfg = {
      ...buildConfig({ enabled: true }),
      commands: { ownerAllowFrom: ["slack:u123owner"] },
    } as OpenClawConfig;
    expect(getSlackExecApprovalApprovers({ cfg: ownerFallbackCfg })).toEqual(["U123OWNER"]);
    expect(
      isSlackExecApprovalAuthorizedSender({ cfg: ownerFallbackCfg, senderId: "U123OWNER" }),
    ).toBe(true);
  });

  it("does not infer approvers from allowFrom or DM default routes", () => {
    const cfg = buildConfig(
      { enabled: true },
      {
        allowFrom: ["slack:U123", "<@U456>"],
        defaultTo: "user:U789",
      },
    );

    expect(getSlackExecApprovalApprovers({ cfg })).toStrictEqual([]);
    expect(isSlackExecApprovalAuthorizedSender({ cfg, senderId: "U789" })).toBe(false);
  });

  it("falls back to commands.ownerAllowFrom for exec approvers", () => {
    const cfg = {
      ...buildConfig({ enabled: true }),
      commands: { ownerAllowFrom: ["slack:U123", "user:U456", "<@U789>"] },
    } as OpenClawConfig;

    expect(getSlackExecApprovalApprovers({ cfg })).toEqual(["U123", "U456", "U789"]);
    expect(isSlackExecApprovalAuthorizedSender({ cfg, senderId: "U456" })).toBe(true);
  });

  it("accepts typed Slack command owners as exec approvers", () => {
    const cfg = {
      ...buildConfig({ enabled: "auto" }),
      commands: {
        ownerAllowFrom: [
          "slack:user:U0123ABCD",
          "slack:team:T0123:user:U0999ZZZZ",
          "telegram:user:1",
        ],
      },
    } as OpenClawConfig;

    expect(getSlackExecApprovalApprovers({ cfg })).toEqual(["U0123ABCD"]);
    expect(isSlackExecApprovalClientEnabled({ cfg })).toBe(true);
    expect(isSlackExecApprovalAuthorizedSender({ cfg, senderId: "U0123ABCD" })).toBe(true);
    expect(isSlackExecApprovalAuthorizedSender({ cfg, senderId: "U0999ZZZZ" })).toBe(false);
  });

  it("defaults target to dm", () => {
    expect(
      resolveSlackExecApprovalTarget({ cfg: buildConfig({ enabled: true, approvers: ["U1"] }) }),
    ).toBe("dm");
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
            { channel: "slack", to: "user:u123target" },
            { channel: "slack", to: "channel:C123" },
          ],
        },
      },
    } as OpenClawConfig;

    expect(isSlackExecApprovalAuthorizedSender({ cfg, senderId: "U123TARGET" })).toBe(true);
    expect(isSlackExecApprovalAuthorizedSender({ cfg, senderId: "u123target" })).toBe(true);
    expect(isSlackExecApprovalAuthorizedSender({ cfg, senderId: "U999OTHER" })).toBe(false);
  });

  it("keeps the local Slack approval prompt path active", () => {
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

  it("normalizes wrapped sender ids", () => {
    expect(normalizeSlackApproverId("user:U123OWNER")).toBe("U123OWNER");
    expect(normalizeSlackApproverId("user:u123owner")).toBe("U123OWNER");
    expect(normalizeSlackApproverId("slack:u123owner")).toBe("U123OWNER");
    expect(normalizeSlackApproverId("slack:user:u123owner")).toBe("U123OWNER");
    expect(normalizeSlackApproverId("slack:team:T123:user:U123OWNER")).toBeUndefined();
    expect(normalizeSlackApproverId("slack:channel:C123CHANNEL")).toBeUndefined();
    expect(normalizeSlackApproverId("<@U123OWNER>")).toBe("U123OWNER");
    expect(normalizeSlackApproverId("<@u123owner>")).toBe("U123OWNER");
    expect(normalizeSlackApproverId("u123owner")).toBe("U123OWNER");
    expect(normalizeSlackApproverId("C123CHANNEL")).toBeUndefined();
    expect(normalizeSlackApproverId("slack:C123CHANNEL")).toBeUndefined();
    expect(normalizeSlackApproverId("user:C123CHANNEL")).toBeUndefined();
    expect(normalizeSlackApproverId("<@C123CHANNEL>")).toBeUndefined();
  });

  it("applies agent and session filters to request handling", async () => {
    const cfg = buildConfig({
      enabled: true,
      approvers: ["U123"],
      agentFilter: ["ops-agent"],
      sessionFilter: ["slack:direct:", "tail$"],
    });

    expect(
      await slackApprovalCapability.nativeRuntimeAsync?.availability.shouldHandle({
        approvalKind: "exec",
        cfg,
        request: {
          id: "req-1",
          request: {
            command: "echo hi",
            agentId: "ops-agent",
            sessionKey: "agent:ops-agent:slack:direct:U123:tail",
          },
          createdAtMs: 0,
          expiresAtMs: 1000,
        },
      }),
    ).toBe(true);

    expect(
      await slackApprovalCapability.nativeRuntimeAsync?.availability.shouldHandle({
        approvalKind: "exec",
        cfg,
        request: {
          id: "req-2",
          request: {
            command: "echo hi",
            agentId: "other-agent",
            sessionKey: "agent:other-agent:slack:direct:U123:tail",
          },
          createdAtMs: 0,
          expiresAtMs: 1000,
        },
      }),
    ).toBe(false);

    expect(
      await slackApprovalCapability.nativeRuntimeAsync?.availability.shouldHandle({
        approvalKind: "exec",
        cfg,
        request: {
          id: "req-3",
          request: {
            command: "echo hi",
            agentId: "ops-agent",
            sessionKey: "agent:ops-agent:discord:channel:123",
          },
          createdAtMs: 0,
          expiresAtMs: 1000,
        },
      }),
    ).toBe(false);
  });

  it("rejects requests bound to another channel or Slack account", async () => {
    const cfg = buildConfig({
      enabled: true,
      approvers: ["U123"],
    });

    expect(
      await slackApprovalCapability.nativeRuntimeAsync?.availability.shouldHandle({
        approvalKind: "exec",
        cfg,
        accountId: "work",
        request: {
          id: "req-1",
          request: {
            command: "echo hi",
            turnSourceChannel: "discord",
            turnSourceAccountId: "work",
          },
          createdAtMs: 0,
          expiresAtMs: 1000,
        },
      }),
    ).toBe(false);

    expect(
      await slackApprovalCapability.nativeRuntimeAsync?.availability.shouldHandle({
        approvalKind: "exec",
        cfg,
        accountId: "work",
        request: {
          id: "req-2",
          request: {
            command: "echo hi",
            turnSourceChannel: "slack",
            turnSourceAccountId: "other",
            sessionKey: "agent:ops-agent:missing",
          },
          createdAtMs: 0,
          expiresAtMs: 1000,
        },
      }),
    ).toBe(false);

    expect(
      await slackApprovalCapability.nativeRuntimeAsync?.availability.shouldHandle({
        approvalKind: "exec",
        cfg,
        accountId: "work",
        request: {
          id: "req-3",
          request: {
            command: "echo hi",
            turnSourceChannel: "slack",
            turnSourceAccountId: "work",
            sessionKey: "agent:ops-agent:missing",
          },
          createdAtMs: 0,
          expiresAtMs: 1000,
        },
      }),
    ).toBe(true);
  });
});
