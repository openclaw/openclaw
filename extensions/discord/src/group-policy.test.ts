import type { ChannelGroupContext } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { afterEach, describe, expect, it } from "vitest";
import { setDiscordPolicyBindings } from "./channel-policy-state.js";
import {
  resolveDiscordGroupRequireMention as requiresMention,
  resolveDiscordGroupToolPolicy as toolPolicy,
} from "./group-policy.js";

function createCfg(discord: Record<string, unknown>): OpenClawConfig {
  return { channels: { discord } } as OpenClawConfig;
}

function guildConfig(guild: Record<string, unknown>) {
  return createCfg({ guilds: { guild } });
}

const denied = { requireMention: true, tools: { deny: ["exec"] } };
const allowed = { requireMention: false, tools: { allow: ["exec"] } };
const allow = (name: string) => ({ allow: [name] });

function group(cfg: OpenClawConfig, groupId: string, senderId?: string, accountId?: string) {
  return { cfg, groupSpace: "guild", groupId, senderId, accountId };
}

function expectPolicy(context: ChannelGroupContext, tools: unknown, mention?: boolean) {
  expect(toolPolicy(context)).toEqual(tools);
  if (mention !== undefined) {
    expect(requiresMention(context)).toBe(mention);
  }
}

function boundContext(channelKey = "ops", groupId = "246") {
  setDiscordPolicyBindings("default", [{ guildKey: "guild", channelKey, channelId: "246" }]);
  return {
    groupSpace: "guild",
    groupId,
    groupChannel: `#${channelKey.replace(/^#/, "")}`,
  };
}

describe("discord group policy", () => {
  afterEach(() => {
    setDiscordPolicyBindings("default", []);
    setDiscordPolicyBindings("work", []);
  });

  it("prefers channel policy, then guild policy, with sender-specific overrides", () => {
    const channel = {
      requireMention: true,
      tools: allow("message.channel"),
      toolsBySender: { "id:user:channel-admin": { deny: ["exec"] } },
    };
    const cfg = guildConfig({
      requireMention: false,
      tools: allow("message.guild"),
      toolsBySender: { "id:user:guild-admin": allow("sessions.list") },
      channels: { "123": channel },
    });
    expectPolicy(group(cfg, "123", "user:channel-admin"), { deny: ["exec"] }, true);
    expectPolicy(group(cfg, "123", "user:someone"), allow("message.channel"));
    expect(toolPolicy(group(cfg, "missing", "user:guild-admin"))).toEqual(allow("sessions.list"));
    expectPolicy(group(cfg, "missing", "user:someone"), allow("message.guild"), false);
  });

  it("honors account-scoped guild and channel overrides", () => {
    const accountGuild = {
      requireMention: false,
      tools: allow("message.account"),
      channels: { "123": { requireMention: true, tools: allow("message.account-channel") } },
    };
    const cfg = createCfg({
      guilds: { guild: { requireMention: true, tools: allow("message.root") } },
      accounts: { work: { guilds: { guild: accountGuild } } },
    });
    expectPolicy(group(cfg, "missing", undefined, "work"), allow("message.account"), false);
    expectPolicy(group(cfg, "123", undefined, "work"), allow("message.account-channel"), true);
  });

  it.each(["ops", "#ops", "2026"])("binds resolved name key %s to its channel id", (channelKey) => {
    const channel = { ...allowed, toolsBySender: { "id:alice": allow("privileged") } };
    const cfg = guildConfig({ ...denied, channels: { [channelKey]: channel } });
    const context = { cfg, ...boundContext(channelKey) };
    expectPolicy({ ...context, groupId: "999" }, denied.tools, true);
    expectPolicy({ ...context, groupId: "999", senderId: "alice" }, denied.tools);
    expectPolicy(context, allowed.tools, false);
    expectPolicy({ ...context, senderId: "alice" }, allow("privileged"));
    expectPolicy({ ...context, groupChannel: "#general" }, allowed.tools);
  });

  it("keeps unresolved name keys matching by name within their own account", () => {
    const guilds = { guild: { ...denied, channels: { ops: allowed } } };
    setDiscordPolicyBindings("work", [{ guildKey: "guild", channelKey: "ops", channelId: "246" }]);
    const context = {
      cfg: createCfg({ guilds, accounts: { work: { guilds } } }),
      groupSpace: "guild",
      groupId: "999",
      groupChannel: "#ops",
    };

    expectPolicy(context, allowed.tools, false);
    expectPolicy({ ...context, accountId: "work" }, denied.tools);
  });

  it("prefers an id entry over a matching name entry", () => {
    const context = {
      cfg: guildConfig({ channels: { "246": denied, ops: allowed } }),
      ...boundContext(),
    };
    expectPolicy(context, denied.tools, true);
  });

  it("prefers a channel sender policy over the guild plain policy", () => {
    const cfg = guildConfig({
      tools: { deny: ["guild"] },
      channels: { channel: { toolsBySender: { "id:alice": { allow: ["channel-sender"] } } } },
    });

    const context = { cfg, groupSpace: "guild", groupId: "channel" };
    expect(toolPolicy({ ...context, senderId: "alice" })).toEqual({ allow: ["channel-sender"] });
    expect(toolPolicy({ ...context, senderId: "bob" })).toEqual({ deny: ["guild"] });
  });

  it("does not use a channel wildcard as fallback", () => {
    const cfg = guildConfig({
      tools: allow("guild"),
      channels: { "*": { tools: { deny: ["channel-wildcard"] } } },
    });
    expectPolicy(group(cfg, "missing"), allow("guild"));
  });

  it("uses the wildcard guild only when no guild matches", () => {
    const cfg = createCfg({
      guilds: {
        "*": { requireMention: false, tools: { allow: ["wildcard"] } },
        exact: {},
      },
    });

    expectPolicy({ cfg, groupSpace: "exact" }, undefined, true);
    expectPolicy({ cfg, groupSpace: "missing" }, allow("wildcard"), false);
  });

  it("matches normalized and hash-prefixed channel slugs", () => {
    const cfg = guildConfig({
      channels: {
        general: { tools: { allow: ["normalized"] } },
        "#ops-room": { tools: { allow: ["hash"] } },
      },
    });

    expectPolicy({ cfg, groupSpace: "guild", groupChannel: "#General" }, allow("normalized"));
    expectPolicy({ cfg, groupSpace: "guild", groupChannel: "Ops Room" }, allow("hash"));
  });

  it("keeps an account empty guild map from inheriting root guilds", () => {
    const cfg = createCfg({
      guilds: { guild: { requireMention: false } },
      accounts: { work: { guilds: {} } },
    });
    expect(requiresMention({ cfg, accountId: "work", groupSpace: "guild" })).toBe(true);
  });

  it("keeps slash-bearing flat scope keys collision-free", () => {
    const cfg = createCfg({
      guilds: {
        "a/channel:b": { tools: { allow: ["slash-guild"] } },
        a: { channels: { b: { tools: { allow: ["nested-channel"] } } } },
      },
    });

    expectPolicy({ cfg, groupSpace: "a/channel:b" }, allow("slash-guild"));
    expectPolicy({ cfg, groupSpace: "a", groupId: "b" }, allow("nested-channel"));
  });
});
