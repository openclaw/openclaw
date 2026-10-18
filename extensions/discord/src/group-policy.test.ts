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

describe("discord group policy", () => {
  afterEach(() => {
    setDiscordPolicyBindings("default", []);
    setDiscordPolicyBindings("work", []);
  });

  it.each(["ops", "#ops", "2026"])("binds resolved name key %s to its channel id", (channelKey) => {
    const cfg = guildConfig({
      ...denied,
      channels: {
        [channelKey]: {
          ...allowed,
          toolsBySender: { "id:alice": { allow: ["privileged"] } },
        },
      },
    });
    setDiscordPolicyBindings("default", [{ guildKey: "guild", channelKey, channelId: "246" }]);
    const context = { cfg, groupSpace: "guild", groupChannel: `#${channelKey.replace(/^#/, "")}` };

    expect(toolPolicy({ ...context, groupId: "999" })).toEqual({ deny: ["exec"] });
    expect(toolPolicy({ ...context, groupId: "999", senderId: "alice" })).toEqual({
      deny: ["exec"],
    });
    expect(requiresMention({ ...context, groupId: "999" })).toBe(true);
    expect(toolPolicy({ ...context, groupId: "246" })).toEqual({ allow: ["exec"] });
    expect(requiresMention({ ...context, groupId: "246" })).toBe(false);
    expect(toolPolicy({ ...context, groupId: "246", senderId: "alice" })).toEqual({
      allow: ["privileged"],
    });
    expect(toolPolicy({ ...context, groupId: "246", groupChannel: "#general" })).toEqual({
      allow: ["exec"],
    });
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

    expect(toolPolicy(context)).toEqual({ allow: ["exec"] });
    expect(requiresMention(context)).toBe(false);
    expect(toolPolicy({ ...context, accountId: "work" })).toEqual({ deny: ["exec"] });
  });

  it("prefers an id entry over a matching name entry", () => {
    setDiscordPolicyBindings("default", [
      { guildKey: "guild", channelKey: "ops", channelId: "246" },
    ]);
    const context = {
      cfg: guildConfig({ channels: { "246": denied, ops: allowed } }),
      groupSpace: "guild",
      groupId: "246",
      groupChannel: "#ops",
    };

    expect(toolPolicy(context)).toEqual({ deny: ["exec"] });
    expect(requiresMention(context)).toBe(true);
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
    expect(
      toolPolicy({
        cfg: guildConfig({
          tools: { allow: ["guild"] },
          channels: {
            "*": { tools: { deny: ["channel-wildcard"] } },
          },
        }),
        groupSpace: "guild",
        groupId: "missing",
      }),
    ).toEqual({ allow: ["guild"] });
  });

  it("uses the wildcard guild only when no guild matches", () => {
    const cfg = createCfg({
      guilds: {
        "*": { requireMention: false, tools: { allow: ["wildcard"] } },
        exact: {},
      },
    });

    expect(requiresMention({ cfg, groupSpace: "exact" })).toBe(true);
    expect(toolPolicy({ cfg, groupSpace: "exact" })).toBeUndefined();
    expect(requiresMention({ cfg, groupSpace: "missing" })).toBe(false);
    expect(toolPolicy({ cfg, groupSpace: "missing" })).toEqual({ allow: ["wildcard"] });
  });

  it("matches normalized and hash-prefixed channel slugs", () => {
    const cfg = guildConfig({
      channels: {
        general: { tools: { allow: ["normalized"] } },
        "#ops-room": { tools: { allow: ["hash"] } },
      },
    });

    expect(toolPolicy({ cfg, groupSpace: "guild", groupChannel: "#General" })).toEqual({
      allow: ["normalized"],
    });
    expect(toolPolicy({ cfg, groupSpace: "guild", groupChannel: "Ops Room" })).toEqual({
      allow: ["hash"],
    });
  });

  it("keeps an account empty guild map from inheriting root guilds", () => {
    expect(
      requiresMention({
        cfg: createCfg({
          guilds: { guild: { requireMention: false } },
          accounts: { work: { guilds: {} } },
        }),
        accountId: "work",
        groupSpace: "guild",
      }),
    ).toBe(true);
  });

  it("keeps slash-bearing flat scope keys collision-free", () => {
    const cfg = createCfg({
      guilds: {
        "a/channel:b": { tools: { allow: ["slash-guild"] } },
        a: { channels: { b: { tools: { allow: ["nested-channel"] } } } },
      },
    });

    expect(toolPolicy({ cfg, groupSpace: "a/channel:b" })).toEqual({ allow: ["slash-guild"] });
    expect(toolPolicy({ cfg, groupSpace: "a", groupId: "b" })).toEqual({
      allow: ["nested-channel"],
    });
  });
});
