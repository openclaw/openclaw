import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setSlackChannelPolicyBindings } from "./channel-policy-state.js";
import { resolveSlackGroupRequireMention, resolveSlackGroupToolPolicy } from "./group-policy.js";
import { registerSlackInstallationState } from "./installation-identity-state.js";

type PolicyContext = Parameters<typeof resolveSlackGroupRequireMention>[0];
type ToolPolicy = ReturnType<typeof resolveSlackGroupToolPolicy>;
type SlackConfig = NonNullable<NonNullable<OpenClawConfig["channels"]>["slack"]>;
function expectPolicies(
  params: PolicyContext,
  mention: boolean,
  tools: ToolPolicy,
  senderTools = tools,
) {
  expect(resolveSlackGroupRequireMention(params)).toBe(mention);
  expect(resolveSlackGroupToolPolicy(params)).toEqual(tools);
  expect(resolveSlackGroupToolPolicy({ ...params, senderId: "user:alice" })).toEqual(senderTools);
}

function channelConfig(
  channels: SlackConfig["channels"],
  overrides: Partial<SlackConfig> = {},
): OpenClawConfig {
  return { channels: { slack: { ...overrides, channels } } };
}

const cfg: OpenClawConfig = {
  channels: {
    slack: {
      botToken: "xoxb-test",
      appToken: "xapp-test",
      channels: {
        alerts: {
          requireMention: false,
          tools: { allow: ["message.send"] },
          toolsBySender: { "id:user:alice": { allow: ["sessions.list"] } },
        },
        "*": { requireMention: true, tools: { deny: ["exec"] } },
      },
    },
  },
};

describe("slack group policy", () => {
  beforeEach(() => {
    setSlackChannelPolicyBindings("default", new Map([["alerts", "C01234567"]]));
  });

  afterEach(() => {
    setSlackChannelPolicyBindings("default", new Map());
  });

  it("does not select another channel's policy from its current display name", () => {
    const params = { cfg, groupId: "c98765432", groupChannel: "#alerts" };

    expectPolicies(params, true, { deny: ["exec"] });
  });

  it("keeps a resolved name policy bound to its channel ID after a rename", () => {
    setSlackChannelPolicyBindings("default", new Map([["alerts", "c01234567"]]));
    const params = { cfg, groupId: "c01234567", groupChannel: "#renamed" };

    expectPolicies(params, false, { allow: ["message.send"] }, { allow: ["sessions.list"] });

    setSlackChannelPolicyBindings("default", new Map());
    expect(resolveSlackGroupRequireMention(params)).toBe(true);
    expect(resolveSlackGroupToolPolicy(params)).toEqual({ deny: ["exec"] });
  });

  it.each(["#alerts", "alerts", "Alerts"])(
    "allows direct name matching for %s only when the merged account enables it",
    (groupChannel) => {
      const nameMatchingCfg = channelConfig(cfg.channels?.slack?.channels, {
        ...cfg.channels?.slack,
        dangerouslyAllowNameMatching: true,
        accounts: { restricted: { dangerouslyAllowNameMatching: false } },
      });
      const params = {
        cfg: nameMatchingCfg,
        accountId: "default",
        groupId: "c98765432",
        groupChannel,
      };

      expectPolicies(params, false, { allow: ["message.send"] }, { allow: ["sessions.list"] });
      expect(resolveSlackGroupRequireMention({ ...params, accountId: "restricted" })).toBe(true);
      expect(resolveSlackGroupToolPolicy({ ...params, accountId: "restricted" })).toEqual({
        deny: ["exec"],
      });
    },
  );

  it("prefers an ID entry over resolved and directly matched name entries", () => {
    const idCfg = channelConfig(
      {
        ...cfg.channels?.slack?.channels,
        C01234567: { requireMention: true, tools: { deny: ["exec"] } },
      },
      { ...cfg.channels?.slack, dangerouslyAllowNameMatching: true },
    );
    const params = { cfg: idCfg, groupId: "c01234567", groupChannel: "#alerts" };

    expectPolicies(params, true, { deny: ["exec"] });
  });

  it("uses matched channel requireMention and wildcard fallback", () => {
    expect(
      resolveSlackGroupRequireMention({ cfg, groupId: "c01234567", groupChannel: "#alerts" }),
    ).toBe(false);
    expect(resolveSlackGroupRequireMention({ cfg, groupChannel: "#missing" })).toBe(true);
  });

  it("resolves sender override, then channel tools, then wildcard tools", () => {
    const params = { cfg, groupId: "c01234567", groupChannel: "#alerts" };
    expect(resolveSlackGroupToolPolicy({ ...params, senderId: "user:alice" })).toEqual({
      allow: ["sessions.list"],
    });
    expect(resolveSlackGroupToolPolicy({ ...params, senderId: "user:bob" })).toEqual({
      allow: ["message.send"],
    });
    expect(
      resolveSlackGroupToolPolicy({ cfg, groupChannel: "#missing", senderId: "user:bob" }),
    ).toEqual({ deny: ["exec"] });
  });

  it.each([
    { configuredChannelId: "C01234567", groupId: "c01234567" },
    { configuredChannelId: "c01234567", groupId: "C01234567" },
    { configuredChannelId: "channel:C01234567", groupId: "c01234567" },
    { configuredChannelId: "channel:c01234567", groupId: "C01234567" },
  ])(
    "applies $configuredChannelId channel and sender policies to session $groupId",
    ({ configuredChannelId, groupId }) => {
      const channelPolicyCfg = {
        channels: {
          slack: {
            channels: {
              [configuredChannelId]: {
                requireMention: false,
                tools: { allow: ["message.send"] },
                toolsBySender: {
                  "id:user:alice": { allow: ["sessions.list"] },
                },
              },
              "*": {
                requireMention: true,
                tools: { deny: ["exec"] },
              },
            },
          },
        },
      } as OpenClawConfig;

      expect(resolveSlackGroupRequireMention({ cfg: channelPolicyCfg, groupId })).toBe(false);
      expect(
        resolveSlackGroupToolPolicy({
          cfg: channelPolicyCfg,
          groupId,
          senderId: "user:bob",
        }),
      ).toEqual({ allow: ["message.send"] });
      expect(
        resolveSlackGroupToolPolicy({
          cfg: channelPolicyCfg,
          groupId,
          senderId: "user:alice",
        }),
      ).toEqual({ allow: ["sessions.list"] });
    },
  );

  it("scopes Enterprise mention and tool policies to the event workspace", () => {
    const installationState = registerSlackInstallationState("default", "enterprise");
    const enterpriseCfg = channelConfig({
      "team:T11111111:channel:C01234567": {
        requireMention: false,
        tools: { allow: ["message.send"] },
      },
      "team:T22222222:channel:C01234567": {
        requireMention: true,
        tools: { deny: ["exec"] },
      },
    });

    try {
      const params = { cfg: enterpriseCfg, groupId: "C01234567" };
      expectPolicies({ ...params, groupSpace: "T11111111" }, false, { allow: ["message.send"] });
      expectPolicies({ ...params, groupSpace: "T22222222" }, true, { deny: ["exec"] });
    } finally {
      installationState.release();
    }
  });

  it("retains bare channel policy matching for workspace installs", () => {
    const installationState = registerSlackInstallationState("default", "workspace");
    const workspaceCfg = {
      channels: {
        slack: {
          channels: {
            C01234567: {
              requireMention: false,
              tools: { allow: ["message.send"] },
            },
          },
        },
      },
    } as OpenClawConfig;

    try {
      expect(
        resolveSlackGroupRequireMention({
          cfg: workspaceCfg,
          groupId: "C01234567",
          groupSpace: "T11111111",
        }),
      ).toBe(false);
      expect(
        resolveSlackGroupToolPolicy({
          cfg: workspaceCfg,
          groupId: "C01234567",
          groupSpace: "T11111111",
        }),
      ).toEqual({ allow: ["message.send"] });
    } finally {
      installationState.release();
    }
  });

  it("prefers the exact channel ID when case variants have different policies", () => {
    const caseSensitiveCfg = channelConfig({
      c01234567: { tools: { allow: ["message.send"] } },
      C01234567: { tools: { deny: ["exec"] } },
    });

    expect(resolveSlackGroupToolPolicy({ cfg: caseSensitiveCfg, groupId: "c01234567" })).toEqual({
      allow: ["message.send"],
    });
    expect(resolveSlackGroupToolPolicy({ cfg: caseSensitiveCfg, groupId: "C01234567" })).toEqual({
      deny: ["exec"],
    });
  });

  it("keeps wildcard fields hidden by a matched whole entry", () => {
    const partialCfg = channelConfig({
      partial: {},
      "*": { requireMention: false, tools: { deny: ["exec"] } },
    });

    expect(resolveSlackGroupRequireMention({ cfg: partialCfg, groupId: "partial" })).toBe(true);
    expect(resolveSlackGroupToolPolicy({ cfg: partialCfg, groupId: "partial" })).toBeUndefined();
  });

  it("does not match channel-prefixed toolsBySender without a message provider", () => {
    const channelSenderCfg = channelConfig({
      alerts: {
        tools: { deny: ["exec"] },
        toolsBySender: {
          "channel:slack:user:alice": { allow: ["exec"] },
        },
      },
    });

    expect(
      resolveSlackGroupToolPolicy({
        cfg: channelSenderCfg,
        groupId: "alerts",
        senderId: "user:alice",
      }),
    ).toEqual({ deny: ["exec"] });
  });
});
