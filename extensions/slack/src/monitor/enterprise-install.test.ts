import type { OpenClawConfig, SlackAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import {
  assertEnterpriseSlackBindingsAreWorkspaceQualified,
  assertEnterpriseSlackPolicyConfig,
  resolveSlackInstallationIdentity,
} from "./enterprise-install.js";

const expectPolicy = (config: SlackAccountConfig) =>
  expect(() => assertEnterpriseSlackPolicyConfig({ accountId: "org", config }));
const bindingConfig = (
  bindings: OpenClawConfig["bindings"],
  defaultAccount = "org",
  accounts: Record<string, SlackAccountConfig> = { org: {} },
): OpenClawConfig => ({
  channels: { slack: { defaultAccount, accounts } },
  bindings,
});

const binding = (
  match: NonNullable<OpenClawConfig["bindings"]>[number]["match"],
  agentId = "channel",
) => ({ match, agentId });
const scopedChannel = "team:T01234567:channel:C01234567";
const scopedUser = "team:T01234567:user:U01234567";
const channelBinding = (id: string, teamId?: string) =>
  binding({ channel: "slack", teamId, peer: { kind: "channel", id } });

describe("resolveSlackInstallationIdentity", () => {
  it.each([
    [
      "human workspace name",
      { auth: { team: "Local Claw", team_id: "T123", is_enterprise_install: false } },
      { kind: "workspace", teamId: "T123", teamName: "Local Claw" },
    ],
    [
      "enterprise without app_id",
      { auth: { enterprise_id: "E123", is_enterprise_install: true } },
      { kind: "enterprise", enterpriseId: "E123" },
    ],
  ] as const)("resolves %s", (_name, params, expected) => {
    expect(resolveSlackInstallationIdentity(params)).toEqual(expected);
  });

  it("rejects mismatched bot and transport app ids", () => {
    expect(() =>
      resolveSlackInstallationIdentity({
        transportApiAppId: "A_TRANSPORT",
        auth: { app_id: "A_BOT", enterprise_id: "E123", is_enterprise_install: true },
      }),
    ).toThrow(/token mismatch/);
  });
});

describe("assertEnterpriseSlackPolicyConfig", () => {
  it("accepts only runtime-supported stable channel forms", () => {
    expectPolicy({
      allowFrom: ["U01234567", "slack:W01234567", "user:U12345678", scopedUser],
      dm: { groupChannels: ["team:T01234567:channel:G01234567"] },
      mentionPatterns: {
        mode: "allow",
        allowIn: ["team:T01234567:channel:C01234567"],
        denyIn: ["team:T12345678:channel:C12345678"],
      },
      channels: {
        [scopedChannel]: {
          users: ["U01234567", "slack:W01234567", "user:B01234567", scopedUser],
          toolsBySender: {
            "id:U01234567": {},
            "id:W01234567": {},
            "id:B01234567": {},
            "channel:slack:U12345678": {},
            "channel:slack:B12345678": {},
            "*": {},
          },
        },
        "team:T12345678:channel:C12345678": {},
        "*": {},
      },
      reactionNotifications: "allowlist",
      reactionAllowlist: ["W01234567", scopedUser],
    }).not.toThrow();
  });

  it.each<[SlackAccountConfig, RegExp]>([
    [{ mentionPatterns: { allowIn: ["C123"] } }, /stable Slack IDs.*mentionPatterns/],
    [{ mentionPatterns: { denyIn: ["C123"] } }, /stable Slack IDs.*mentionPatterns/],
    [{ channels: { C01234567: {} } }, /Slack Enterprise Grid/],
    [{ dm: { groupChannels: ["G01234567"] } }, /Slack Enterprise Grid/],
    [{ allowFrom: ["ursula"] }, /stable Slack/],
    [{ reactionNotifications: "allowlist", reactionAllowlist: ["ursula"] }, /stable Slack/],
    [{ dangerouslyAllowNameMatching: true }, /cannot use dangerouslyAllowNameMatching/],
    [
      {
        channels: {
          [scopedChannel]: {
            toolsBySender: {
              "user:U01234567": { deny: ["exec"] },
              "*": { allow: ["exec"] },
            },
          },
        },
      },
      /stable Slack IDs.*toolsBySender/,
    ],
    [{ dm: { groupChannels: ["*"] } }, /stable Slack IDs.*dm\.groupChannels/],
    [{ channels: { "#general": {} } }, /stable Slack channel IDs/],
  ])("rejects unsupported Enterprise policy %j", (config, error) => {
    expectPolicy(config).toThrow(error);
  });
});

describe("assertEnterpriseSlackBindingsAreWorkspaceQualified", () => {
  const expectBindings = (cfg: OpenClawConfig, accountId = "org") =>
    expect(() => assertEnterpriseSlackBindingsAreWorkspaceQualified({ cfg, accountId }));
  it("canonicalizes binding account IDs the same way as runtime routing", () => {
    const cfg = bindingConfig(
      [binding({ ...channelBinding("C01234567").match, accountId: "WORK" }, "main")],
      "other",
      { work: {}, other: {} },
    );

    expectBindings(cfg, "work").toThrow(/requires configured Slack binding peers/);
    expectBindings(cfg, "other").not.toThrow();
  });

  it("requires workspace scope only on bindings that apply to the Enterprise account", () => {
    const cfg = bindingConfig([binding({ channel: "slack" }, "main")], "workspace", {
      workspace: {},
      enterprise: {},
    });

    expectBindings(cfg, "enterprise").not.toThrow();
    expectBindings(cfg, "workspace").toThrow(/requires match\.teamId/);
  });

  it("accepts team-scoped and workspace-qualified peer bindings", () => {
    const cfg = bindingConfig([
      binding({ channel: "slack", teamId: "T01234567" }, "team"),
      channelBinding(scopedChannel),
    ]);

    expectBindings(cfg).not.toThrow();
  });

  it("rejects unqualified or conflicting Enterprise peer bindings", () => {
    const unqualified = bindingConfig([channelBinding("C01234567")]);
    const conflicting = bindingConfig([channelBinding(scopedChannel, "T99999999")]);

    expectBindings(unqualified).toThrow(/requires configured Slack binding peers/);
    expectBindings(conflicting).toThrow(/conflicting workspace IDs/);
  });

  it("retains the workspace boundary for configured ACP bindings", () => {
    const cfg = bindingConfig([{ ...channelBinding(scopedChannel), type: "acp" }]);

    expectBindings(cfg).toThrow(/cannot use configured ACP bindings/);
  });
});
