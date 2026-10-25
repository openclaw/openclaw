import type { ExecApprovalRequestPayload } from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { slackApprovalCapability } from "./approval-native.js";
import { buildConfig as slackConfig } from "./approval-native.test-support.js";
import {
  getSlackExecApprovalApprovers,
  isSlackExecApprovalAuthorizedSender,
  isSlackExecApprovalClientEnabled,
  normalizeSlackApproverId,
  shouldSuppressLocalSlackExecApprovalPrompt,
} from "./exec-approvals.js";

type SlackConfig = NonNullable<NonNullable<OpenClawConfig["channels"]>["slack"]>;
function buildConfig(
  execApprovals?: SlackConfig["execApprovals"],
  channelOverrides?: Partial<SlackConfig>,
): OpenClawConfig {
  return slackConfig({ ...channelOverrides, execApprovals });
}

const availability = slackApprovalCapability.nativeRuntimeAsync!.availability;
function shouldHandle(cfg: OpenClawConfig, request: ExecApprovalRequestPayload) {
  return availability.shouldHandle({
    approvalKind: "exec",
    cfg,
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
    expect(
      [
        buildConfig(),
        buildConfig({ enabled: true }),
        buildConfig({ approvers: ["U123"] }),
        { ...buildConfig(), commands: { ownerAllowFrom: ["slack:U123OWNER"] } },
        buildConfig({ enabled: "auto", approvers: ["U123"] }),
        buildConfig({ enabled: false, approvers: ["U123"] }),
      ].map(clientEnabled),
    ).toEqual([false, false, false, false, true, false]);
  });

  it.each([
    [
      "explicit over routes",
      buildConfig({ approvers: ["u456"] }, { allowFrom: ["U123"], defaultTo: "user:U789" }),
      ["U456"],
      ["U456", "u456", "U123"],
      [true, true, false],
    ],
    [
      "no inferred route owners",
      buildConfig(
        { enabled: true },
        { allowFrom: ["slack:U123", "<@U456>"], defaultTo: "user:U789" },
      ),
      [],
      ["U789"],
      [false],
    ],
  ] satisfies Array<[string, OpenClawConfig, string[], string[], boolean[]]>)(
    "resolves and authorizes %s",
    (_name, cfg, approvers, senders, allowed) => {
      expect(getSlackExecApprovalApprovers({ cfg })).toStrictEqual(approvers);
      expect(authorized(cfg, ...senders)).toEqual(allowed);
    },
  );

  it("accepts typed Slack command owners as exec approvers", () => {
    const cfg = withOwners(
      ["slack:user:U0123ABCD", "slack:team:T0123:user:U0999ZZZZ", "telegram:user:1"],
      "auto",
    );

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
    const valid = ["user:U1", "user:u1", "slack:u1", "slack:user:u1", "<@U1>", "<@u1>", "u1"];
    const invalid = [
      "slack:team:T123:user:U123OWNER",
      "slack:channel:C123CHANNEL",
      "C123CHANNEL",
      "slack:C123CHANNEL",
      "user:C123CHANNEL",
      "<@C123CHANNEL>",
    ];
    expect(valid.map(normalizeSlackApproverId)).toEqual(valid.map(() => "U1"));
    expect(invalid.map(normalizeSlackApproverId)).toEqual(invalid.map(() => undefined));
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
