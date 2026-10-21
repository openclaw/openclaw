import type { ExecApprovalRequestPayload } from "openclaw/plugin-sdk/approval-runtime";
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

type SlackConfig = NonNullable<NonNullable<OpenClawConfig["channels"]>["slack"]>;
function buildConfig(
  execApprovals?: SlackConfig["execApprovals"],
  channelOverrides?: Partial<SlackConfig>,
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

const availability = slackApprovalCapability.nativeRuntimeAsync!.availability;
function shouldHandle(
  cfg: OpenClawConfig,
  request: ExecApprovalRequestPayload,
  accountId?: string,
) {
  return availability.shouldHandle({
    approvalKind: "exec",
    cfg,
    accountId,
    request: { id: "req-1", request, createdAtMs: 0, expiresAtMs: 1000 },
  });
}

function clientEnabled(cfg: OpenClawConfig) {
  return isSlackExecApprovalClientEnabled({ cfg });
}

function authorized(cfg: OpenClawConfig, ...senderIds: string[]) {
  return senderIds.map((senderId) => isSlackExecApprovalAuthorizedSender({ cfg, senderId }));
}

describe("slack exec approvals", () => {
  it("requires explicit enablement even when owner approvers resolve", () => {
    expect(clientEnabled(buildConfig())).toBe(false);
    expect(clientEnabled(buildConfig({ enabled: true }))).toBe(false);
    expect(clientEnabled(buildConfig({ approvers: ["U123"] }))).toBe(false);
    expect(
      clientEnabled({ ...buildConfig(), commands: { ownerAllowFrom: ["slack:U123OWNER"] } }),
    ).toBe(false);
    expect(clientEnabled(buildConfig({ enabled: "auto", approvers: ["U123"] }))).toBe(true);
    expect(clientEnabled(buildConfig({ enabled: false, approvers: ["U123"] }))).toBe(false);
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
    expect(authorized(cfg, "U456", "u456", "U123")).toEqual([true, true, false]);
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
    expect(authorized(cfg, "U789")).toEqual([false]);
  });

  it("falls back to commands.ownerAllowFrom for exec approvers", () => {
    const cfg = {
      ...buildConfig({ enabled: true }),
      commands: { ownerAllowFrom: ["slack:U123", "user:U456", "<@U789>"] },
    } as OpenClawConfig;

    expect(getSlackExecApprovalApprovers({ cfg })).toEqual(["U123", "U456", "U789"]);
    expect(authorized(cfg, "U456")).toEqual([true]);
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
    expect(authorized(cfg, "U0123ABCD", "U0999ZZZZ")).toEqual([true, false]);
  });

  it("defaults target to dm", () => {
    expect(
      resolveSlackExecApprovalTarget({ cfg: buildConfig({ enabled: true, approvers: ["U1"] }) }),
    ).toBe("dm");
  });

  it("matches slack target recipients from generic approval forwarding targets", () => {
    const cfg = {
      ...buildConfig(),
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

    expect(authorized(cfg, "U123TARGET", "u123target", "U999OTHER")).toEqual([true, true, false]);
  });

  it("keeps the local Slack approval prompt path active", () => {
    const payload = {
      channelData: { execApproval: { approvalId: "req-1", approvalSlug: "req-1" } },
    };

    const configs = [buildConfig({ enabled: true, approvers: ["U123"] }), buildConfig()];
    expect(
      configs.map((cfg) => shouldSuppressLocalSlackExecApprovalPrompt({ cfg, payload })),
    ).toEqual([true, false]);
  });

  it("normalizes wrapped sender ids", () => {
    const valid = [
      "user:U123OWNER",
      "user:u123owner",
      "slack:u123owner",
      "slack:user:u123owner",
      "<@U123OWNER>",
      "<@u123owner>",
      "u123owner",
    ];
    const invalid = [
      "slack:team:T123:user:U123OWNER",
      "slack:channel:C123CHANNEL",
      "C123CHANNEL",
      "slack:C123CHANNEL",
      "user:C123CHANNEL",
      "<@C123CHANNEL>",
    ];
    for (const id of valid) {
      expect(normalizeSlackApproverId(id), id).toBe("U123OWNER");
    }
    for (const id of invalid) {
      expect(normalizeSlackApproverId(id), id).toBeUndefined();
    }
  });

  it("applies agent and session filters to request handling", async () => {
    const cfg = buildConfig({
      enabled: true,
      approvers: ["U123"],
      agentFilter: ["ops-agent"],
      sessionFilter: ["slack:direct:", "tail$"],
    });

    const request = {
      command: "echo hi",
      agentId: "ops-agent",
      sessionKey: "agent:ops-agent:slack:direct:U123:tail",
    };
    expect(await shouldHandle(cfg, request)).toBe(true);
    expect(
      await shouldHandle(cfg, {
        ...request,
        agentId: "other-agent",
        sessionKey: "agent:other-agent:slack:direct:U123:tail",
      }),
    ).toBe(false);
    expect(
      await shouldHandle(cfg, { ...request, sessionKey: "agent:ops-agent:discord:channel:123" }),
    ).toBe(false);
  });

  it("rejects requests bound to another channel or Slack account", async () => {
    const cfg = buildConfig({
      enabled: true,
      approvers: ["U123"],
    });

    const request = {
      command: "echo hi",
      turnSourceChannel: "discord",
      turnSourceAccountId: "work",
    };
    expect(await shouldHandle(cfg, request, "work")).toBe(false);
    const slackRequest = {
      ...request,
      turnSourceChannel: "slack",
      sessionKey: "agent:ops-agent:missing",
    };
    expect(await shouldHandle(cfg, { ...slackRequest, turnSourceAccountId: "other" }, "work")).toBe(
      false,
    );
    expect(await shouldHandle(cfg, slackRequest, "work")).toBe(true);
  });
});
