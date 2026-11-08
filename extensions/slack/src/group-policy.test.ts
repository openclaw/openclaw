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
const bound = { cfg, groupId: "c01234567", groupChannel: "#alerts" };

describe("slack group policy", () => {
  beforeEach(() => {
    setSlackChannelPolicyBindings("default", new Map([["alerts", "C01234567"]]));
  });

  afterEach(() => {
    setSlackChannelPolicyBindings("default", new Map());
  });

  it("keeps a resolved name policy bound to its channel ID after a rename", () => {
    setSlackChannelPolicyBindings("default", new Map([["alerts", "c01234567"]]));
    const params = { cfg, groupId: "c01234567", groupChannel: "#renamed" };

    expectPolicies(params, false, allowed, senderAllowed);

    setSlackChannelPolicyBindings("default", new Map());
    expect(resolveSlackGroupRequireMention(params)).toBe(true);
    expect(resolveSlackGroupToolPolicy(params)).toEqual(denied);
  });

  it.each(["#Alerts", "alerts"])(
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

  it.each<[string, PolicyContext, boolean, ToolPolicy, ToolPolicy]>([
    ["unbound display name", { ...bound, groupId: "c98765432" }, true, denied, denied],
    ["bound sender override", { ...bound, senderId: "user:bob" }, false, allowed, senderAllowed],
    ["missing channel wildcard", { cfg, groupChannel: "#missing" }, true, denied, denied],
    [
      "ID before name",
      {
        ...bound,
        cfg: channelConfig(
          { alerts: channelPolicy, C01234567: fallbackPolicy },
          { dangerouslyAllowNameMatching: true },
        ),
      },
      true,
      denied,
      denied,
    ],
    [
      "whole entry hides wildcard",
      {
        cfg: channelConfig({ partial: {}, "*": { requireMention: false, tools: denied } }),
        groupId: "partial",
      },
      true,
      undefined,
      undefined,
    ],
    [
      "sender needs provider",
      {
        cfg: channelConfig({
          alerts: {
            tools: denied,
            toolsBySender: { "channel:slack:user:alice": { allow: ["exec"] } },
          },
        }),
        groupId: "alerts",
        senderId: "user:alice",
      },
      true,
      denied,
      denied,
    ],
  ])("resolves %s", (_name, params, mention, tools, senderTools) => {
    expectPolicies(params, mention, tools, senderTools);
  });

  it.each([
    ["C01234567", "c01234567"],
    ["c01234567", "C01234567"],
    ["channel:C01234567", "c01234567"],
    ["channel:c01234567", "C01234567"],
  ])("normalizes %s for persisted session %s", (key, groupId) => {
    expectPolicies(
      { cfg: channelConfig({ [key]: channelPolicy }), groupId },
      false,
      allowed,
      senderAllowed,
    );
  });

  it.each(["c01234567", "C01234567"])("prefers exact case for %s", (groupId) => {
    const policyCfg = channelConfig({
      c01234567: { tools: allowed },
      C01234567: { tools: denied },
    });
    expect(resolveSlackGroupToolPolicy({ cfg: policyCfg, groupId })).toEqual(
      groupId.startsWith("c") ? allowed : denied,
    );
  });

  it.each(["workspace", "enterprise"] as const)("scopes policies for %s installs", (kind) => {
    const installation = registerSlackInstallationState("default", kind);
    const policyCfg = channelConfig(
      kind === "workspace"
        ? { C01234567: channelPolicy }
        : {
            "team:T11111111:channel:C01234567": { requireMention: false, tools: allowed },
            "team:T22222222:channel:C01234567": fallbackPolicy,
          },
    );
    try {
      const params = { cfg: policyCfg, groupId: "C01234567", groupSpace: "T11111111" };
      expectPolicies(params, false, allowed, kind === "workspace" ? senderAllowed : allowed);
      if (kind === "enterprise") {
        expectPolicies({ ...params, groupSpace: "T22222222" }, true, denied);
      }
    } finally {
      installation.release();
    }
  });
});
