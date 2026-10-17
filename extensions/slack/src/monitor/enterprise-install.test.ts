import type { OpenClawConfig, SlackAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import {
  assertEnterpriseSlackBindingsAreWorkspaceQualified,
  assertEnterpriseSlackPolicyConfig,
  resolveSlackInstallationIdentity,
} from "./enterprise-install.js";

const checkPolicy = (config: SlackAccountConfig) =>
  assertEnterpriseSlackPolicyConfig({ accountId: "org", config });
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

describe("resolveSlackInstallationIdentity", () => {
  it.each([
    ["degraded without auth.test", {}, { kind: "degraded", reason: "auth_test_failed" }],
    [
      "workspace transport app id",
      { auth: { team_id: "T123", is_enterprise_install: false }, transportApiAppId: "A123" },
      { kind: "workspace", teamId: "T123", apiAppId: "A123" },
    ],
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
    [
      "enterprise transport app id",
      { auth: { enterprise_id: "E123", is_enterprise_install: true }, transportApiAppId: "A123" },
      { kind: "enterprise", apiAppId: "A123", enterpriseId: "E123" },
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
    expect(() =>
      checkPolicy({
        allowFrom: [
          "U01234567",
          "slack:W01234567",
          "user:U12345678",
          "team:T01234567:user:U01234567",
        ],
        dm: { groupChannels: ["team:T01234567:channel:G01234567"] },
        mentionPatterns: {
          mode: "allow",
          allowIn: ["team:T01234567:channel:C01234567"],
          denyIn: ["team:T12345678:channel:C12345678"],
        },
        channels: {
          "team:T01234567:channel:C01234567": {
            users: [
              "U01234567",
              "slack:W01234567",
              "user:B01234567",
              "team:T01234567:user:U01234567",
            ],
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
        reactionAllowlist: ["W01234567", "team:T01234567:user:U01234567"],
      }),
    ).not.toThrow();
  });

  it.each(["allowIn", "denyIn"] as const)(
    "rejects unqualified Enterprise mention pattern policy %s",
    (field) => {
      expect(() => checkPolicy({ mentionPatterns: { [field]: ["C123"] } })).toThrow(
        /stable Slack IDs.*mentionPatterns/,
      );
    },
  );

  it("rejects the mutable-name matching escape hatch", () => {
    expect(() => checkPolicy({ dangerouslyAllowNameMatching: true })).toThrow(
      /cannot use dangerouslyAllowNameMatching/,
    );
  });

  it.each<[string, SlackAccountConfig]>([
    ["channel ID", { channels: { C01234567: {} } }],
    ["group DM channel ID", { dm: { groupChannels: ["G01234567"] } }],
  ])("rejects unscoped Enterprise %s", (_label, config) => {
    expect(() => checkPolicy(config)).toThrow(/Slack Enterprise Grid/);
  });

  it.each<[string, SlackAccountConfig]>([
    ["allowFrom", { allowFrom: ["ursula"] }],
    ["reaction allowlist", { reactionNotifications: "allowlist", reactionAllowlist: ["ursula"] }],
  ])("rejects lowercase mutable names in %s", (_label, config) => {
    expect(() => checkPolicy(config)).toThrow(/stable Slack/);
  });

  it("rejects noncanonical toolsBySender keys before wildcard fallback", () => {
    expect(() =>
      checkPolicy({
        channels: {
          "team:T01234567:channel:C01234567": {
            toolsBySender: {
              "user:U01234567": { deny: ["exec"] },
              "*": { allow: ["exec"] },
            },
          },
        },
      }),
    ).toThrow(/stable Slack IDs.*toolsBySender/);
  });

  it("rejects wildcard groupChannels", () => {
    expect(() => checkPolicy({ dm: { groupChannels: ["*"] } })).toThrow(
      /stable Slack IDs.*dm\.groupChannels/,
    );
  });

  it("rejects channel names", () => {
    expect(() => checkPolicy({ channels: { "#general": {} } })).toThrow(/stable Slack channel IDs/);
  });
});

describe("assertEnterpriseSlackBindingsAreWorkspaceQualified", () => {
  const expectBindings = (cfg: OpenClawConfig, accountId = "org") =>
    expect(() => assertEnterpriseSlackBindingsAreWorkspaceQualified({ cfg, accountId }));
  it("canonicalizes binding account IDs the same way as runtime routing", () => {
    const cfg = bindingConfig(
      [
        binding(
          {
            channel: "slack",
            accountId: "WORK",
            peer: { kind: "channel", id: "C01234567" },
          },
          "main",
        ),
      ],
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
      binding({
        channel: "slack",
        peer: { kind: "channel", id: "team:T01234567:channel:C01234567" },
      }),
    ]);

    expectBindings(cfg).not.toThrow();
  });

  it("rejects unqualified or conflicting Enterprise peer bindings", () => {
    const unqualified = bindingConfig([
      binding({ channel: "slack", peer: { kind: "channel", id: "C01234567" } }),
    ]);
    const conflicting = bindingConfig([
      binding({
        channel: "slack",
        teamId: "T99999999",
        peer: { kind: "channel", id: "team:T01234567:channel:C01234567" },
      }),
    ]);

    expectBindings(unqualified).toThrow(/requires configured Slack binding peers/);
    expectBindings(conflicting).toThrow(/conflicting workspace IDs/);
  });

  it("retains the workspace boundary for configured ACP bindings", () => {
    const cfg = bindingConfig([
      {
        type: "acp",
        match: {
          channel: "slack",
          peer: { kind: "channel", id: "team:T01234567:channel:C01234567" },
        },
        agentId: "channel",
      },
    ]);

    expectBindings(cfg).toThrow(/cannot use configured ACP bindings/);
  });
});
