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
  // Expected policy constants must not share objects with the config under test.
  return { channels: { slack: { ...overrides, channels: structuredClone(channels) } } };
}

const allowed = { allow: ["message.send"] };
const denied = { deny: ["exec"] };
const senderAllowed = { allow: ["sessions.list"] };
const channelPolicy = {
  requireMention: false,
  tools: allowed,
  toolsBySender: { "id:user:alice": senderAllowed },
};
const fallbackPolicy = { requireMention: true, tools: denied };
const cfg = channelConfig(
  { alerts: channelPolicy, "*": fallbackPolicy },
  {
    botToken: "xoxb-test",
    appToken: "xapp-test",
  },
);

describe("slack group policy", () => {
  beforeEach(() => {
    setSlackChannelPolicyBindings("default", new Map([["alerts", "C01234567"]]));
  });

  afterEach(() => {
    setSlackChannelPolicyBindings("default", new Map());
  });

  it("does not select another channel's policy from its current display name", () => {
    expectPolicies({ cfg, groupId: "c98765432", groupChannel: "#alerts" }, true, denied);
  });

  it("keeps a resolved name policy bound to its channel ID after a rename", () => {
    setSlackChannelPolicyBindings("default", new Map([["alerts", "c01234567"]]));
    const params = { cfg, groupId: "c01234567", groupChannel: "#renamed" };

    expectPolicies(params, false, allowed, senderAllowed);

    setSlackChannelPolicyBindings("default", new Map());
    expect(resolveSlackGroupRequireMention(params)).toBe(true);
    expect(resolveSlackGroupToolPolicy(params)).toEqual(denied);
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

      expectPolicies(params, false, allowed, senderAllowed);
      expect(resolveSlackGroupRequireMention({ ...params, accountId: "restricted" })).toBe(true);
      expect(resolveSlackGroupToolPolicy({ ...params, accountId: "restricted" })).toEqual(denied);
    },
  );

  it("prefers an ID entry over resolved and directly matched name entries", () => {
    const idCfg = channelConfig(
      {
        ...cfg.channels?.slack?.channels,
        C01234567: fallbackPolicy,
      },
      { ...cfg.channels?.slack, dangerouslyAllowNameMatching: true },
    );
    const params = { cfg: idCfg, groupId: "c01234567", groupChannel: "#alerts" };

    expectPolicies(params, true, denied);
  });

  it("resolves matched mention and sender policies before wildcard fallback", () => {
    expectPolicies(
      { cfg, groupId: "c01234567", groupChannel: "#alerts", senderId: "user:bob" },
      false,
      allowed,
      senderAllowed,
    );
    expectPolicies({ cfg, groupChannel: "#missing", senderId: "user:bob" }, true, denied);
  });

  it.each([
    { configuredChannelId: "C01234567", groupId: "c01234567" },
    { configuredChannelId: "c01234567", groupId: "C01234567" },
    { configuredChannelId: "channel:C01234567", groupId: "c01234567" },
    { configuredChannelId: "channel:c01234567", groupId: "C01234567" },
  ])(
    "applies $configuredChannelId channel and sender policies to session $groupId",
    ({ configuredChannelId, groupId }) => {
      const channelPolicyCfg = channelConfig({
        [configuredChannelId]: channelPolicy,
        "*": fallbackPolicy,
      });
      expectPolicies(
        { cfg: channelPolicyCfg, groupId, senderId: "user:bob" },
        false,
        allowed,
        senderAllowed,
      );
    },
  );

  it("scopes Enterprise mention and tool policies to the event workspace", () => {
    const installationState = registerSlackInstallationState("default", "enterprise");
    const enterpriseCfg = channelConfig({
      "team:T11111111:channel:C01234567": { requireMention: false, tools: allowed },
      "team:T22222222:channel:C01234567": fallbackPolicy,
    });

    try {
      const params = { cfg: enterpriseCfg, groupId: "C01234567" };
      expectPolicies({ ...params, groupSpace: "T11111111" }, false, allowed);
      expectPolicies({ ...params, groupSpace: "T22222222" }, true, denied);
    } finally {
      installationState.release();
    }
  });

  it("retains bare channel policy matching for workspace installs", () => {
    const installationState = registerSlackInstallationState("default", "workspace");
    const workspaceCfg = channelConfig({ C01234567: channelPolicy });

    try {
      expectPolicies(
        { cfg: workspaceCfg, groupId: "C01234567", groupSpace: "T11111111" },
        false,
        allowed,
        senderAllowed,
      );
    } finally {
      installationState.release();
    }
  });

  it("prefers the exact channel ID when case variants have different policies", () => {
    const caseSensitiveCfg = channelConfig({
      c01234567: { tools: allowed },
      C01234567: { tools: denied },
    });

    expect(resolveSlackGroupToolPolicy({ cfg: caseSensitiveCfg, groupId: "c01234567" })).toEqual(
      allowed,
    );
    expect(resolveSlackGroupToolPolicy({ cfg: caseSensitiveCfg, groupId: "C01234567" })).toEqual(
      denied,
    );
  });

  it("keeps wildcard fields hidden by a matched whole entry", () => {
    const partialCfg = channelConfig({
      partial: {},
      "*": { requireMention: false, tools: denied },
    });

    expect(resolveSlackGroupRequireMention({ cfg: partialCfg, groupId: "partial" })).toBe(true);
    expect(resolveSlackGroupToolPolicy({ cfg: partialCfg, groupId: "partial" })).toBeUndefined();
  });

  it("does not match channel-prefixed toolsBySender without a message provider", () => {
    const channelSenderCfg = channelConfig({
      alerts: {
        tools: denied,
        toolsBySender: { "channel:slack:user:alice": { allow: ["exec"] } },
      },
    });

    expect(
      resolveSlackGroupToolPolicy({
        cfg: channelSenderCfg,
        groupId: "alerts",
        senderId: "user:alice",
      }),
    ).toEqual(denied);
  });
});
