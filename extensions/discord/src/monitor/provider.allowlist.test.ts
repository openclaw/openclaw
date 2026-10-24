import type { DiscordGuildEntry } from "openclaw/plugin-sdk/config-contracts";
import { createNonExitingRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  getDiscordChannelPolicyBinding,
  findDiscordGuildPolicyKey,
  setDiscordPolicyBindings,
} from "../channel-policy-state.js";
import { resolveDiscordGroupToolPolicy } from "../group-policy.js";
import * as channels from "../resolve-channels.js";
import * as users from "../resolve-users.js";
import { resolveDiscordAllowlistConfig } from "./provider.allowlist.js";

const denyExec = { deny: ["exec"] };
const allowExec = { allow: ["exec"] };
const allowRead = { allow: ["read"] };
function resolvedChannel(input: string, channelName = "general", channelId = "246") {
  return { input, resolved: true, guildId: "145", guildName: "Ops", channelId, channelName };
}

afterEach(() => {
  setDiscordPolicyBindings("default", []);
  setDiscordPolicyBindings("work", []);
});
beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(channels, "resolveDiscordChannelAllowlist").mockResolvedValue([]);
  const identities: Record<string, { resolved: boolean; id?: string; name?: string }> = {
    Alice: { resolved: true, id: "111" },
    Bob: { resolved: true, id: "222" },
    Carol: { resolved: false },
    "387": { resolved: true, id: "387", name: "Peter" },
  };
  vi.spyOn(users, "resolveDiscordUserAllowlist").mockImplementation(async ({ entries }) =>
    entries.map((input) => ({ input, ...(identities[input] ?? { resolved: true, id: input }) })),
  );
});

function resolve(overrides: Partial<Parameters<typeof resolveDiscordAllowlistConfig>[0]>) {
  return resolveDiscordAllowlistConfig({
    accountId: "default",
    token: "synthetic-token",
    allowFrom: [],
    guildEntries: {},
    discordConfig: {},
    fetcher: vi.fn(),
    runtime: createNonExitingRuntimeEnv(),
    ...overrides,
  });
}

it("uses numeric policies without resolving user names unless explicitly enabled", async () => {
  const guildEntries = {
    "111": {
      users: ["Bob", "333"],
      channels: { "222": { users: ["Carol", "888"], allow: true } },
    },
    "444": { users: ["555"] },
  };
  const result = await resolve({ guildEntries, allowFrom: ["Alice", "111", "*"] });
  expect(result).toEqual({ guildEntries, allowFrom: ["Alice", "111", "*"] });
  expect(channels.resolveDiscordChannelAllowlist).not.toHaveBeenCalled();
  expect(users.resolveDiscordUserAllowlist).not.toHaveBeenCalled();
});

it("canonicalizes permitted names while preserving unresolved entries and numeric channel policy", async () => {
  vi.mocked(channels.resolveDiscordChannelAllowlist).mockResolvedValueOnce([
    resolvedChannel("ops/246", "dev"),
    {
      input: "145/missing",
      resolved: false,
      guildId: "145",
      guildName: "Ops",
      channelName: "missing-room",
    },
  ]);
  const runtime = createNonExitingRuntimeEnv();
  const result = await resolve({
    runtime,
    discordConfig: { dangerouslyAllowNameMatching: true },
    allowFrom: ["Alice", "111", "*", "387"],
    guildEntries: {
      "*": { users: ["Bob", "999"], channels: { "*": { users: ["Carol", "888"] } } },
      "145": { channels: { "246": {}, "999": {}, missing: {} } },
      ops: { channels: { "246": {} } },
    },
  });
  expect(result).toMatchObject({
    allowFrom: ["111", "*", "387"],
    guildEntries: {
      "*": { users: ["222", "999"], channels: { "*": { users: ["Carol", "888"] } } },
    },
  });
  expect(result.guildEntries?.["145"]?.channels).toEqual({ "246": {}, "999": {}, missing: {} });
  expect(users.resolveDiscordUserAllowlist).toHaveBeenCalledTimes(2);
  const logs = vi.mocked(runtime.log).mock.calls.flat().join("\n");
  expect(logs.match(/145\/246/g)).toHaveLength(1);
  expect(logs).toContain("aliases:ops/246");
  expect(logs).toContain(
    "discord channels unresolved: 145/missing (guild:Ops; channel:missing-room)",
  );
  expect(logs).toContain("discord users resolved: Alice→111, 387→Peter");
  expect(logs).not.toContain("(id:387)");
});

it.each(["unresolved", "failed", "removed"])(
  "replaces previous channel bindings when a policy resolution is %s",
  async (outcome) => {
    setDiscordPolicyBindings(
      "work",
      [{ guildKey: "145", channelKey: "ops", channelId: "246" }],
      new Map([["145", "ops"]]),
    );
    if (outcome === "failed") {
      vi.mocked(channels.resolveDiscordChannelAllowlist).mockRejectedValueOnce(
        new Error("synthetic lookup failure"),
      );
    } else {
      vi.mocked(channels.resolveDiscordChannelAllowlist).mockResolvedValueOnce([
        { input: "145/ops", resolved: false, guildId: "145" },
      ]);
    }

    await resolve({
      accountId: "work",
      guildEntries: outcome === "removed" ? {} : { "145": { channels: { ops: {} } } },
    });

    expect(getDiscordChannelPolicyBinding("work", "145", "ops")).toBeUndefined();
    expect(findDiscordGuildPolicyKey("work", "145")).toBeUndefined();
  },
);

it.each(["general", "2026", "246", undefined])(
  "resolves channel %s and tool policy without enabling user name matching",
  async (channelKey) => {
    const guilds = {
      ops: {
        users: ["Bob"],
        tools: channelKey ? allowExec : denyExec,
        channels: channelKey ? { [channelKey]: { users: ["Carol"], tools: denyExec } } : undefined,
      },
    };
    vi.mocked(channels.resolveDiscordChannelAllowlist).mockResolvedValueOnce([
      {
        ...resolvedChannel(channelKey ? `ops/${channelKey}` : "ops"),
        channelId: channelKey ? "246" : undefined,
        channelName: channelKey ? "general" : undefined,
      },
    ]);
    const resolved = await resolve({ guildEntries: guilds, allowFrom: ["Alice"] });
    expect(resolved).toMatchObject({
      allowFrom: ["Alice"],
      guildEntries: { ops: { users: ["Bob"] } },
    });
    expect(channels.resolveDiscordChannelAllowlist).toHaveBeenCalledTimes(1);
    expect(users.resolveDiscordUserAllowlist).not.toHaveBeenCalled();
    if (channelKey) {
      expect(resolved.guildEntries?.["145"]?.channels?.["246"]?.users).toEqual(["Carol"]);
      expect(getDiscordChannelPolicyBinding("default", "ops", channelKey)).toBe(
        channelKey === "246" ? undefined : "246",
      );
      expect(getDiscordChannelPolicyBinding("work", "ops", channelKey)).toBeUndefined();
    }
    const admittedGuild = resolved.guildEntries?.["145"];
    expect(channelKey ? admittedGuild?.channels?.["246"]?.tools : admittedGuild?.tools).toEqual(
      denyExec,
    );
    expect(findDiscordGuildPolicyKey("work", "145")).toBeUndefined();
    const context = {
      accountId: "default",
      groupSpace: "145",
      groupId: "246",
      groupChannel: "general",
    };
    const toolPolicy = (entries: Record<string, DiscordGuildEntry>) =>
      resolveDiscordGroupToolPolicy({
        ...context,
        cfg: { channels: { discord: { guilds: entries } } },
      });
    expect(toolPolicy({ "*": { tools: allowExec }, ...guilds })).toEqual(denyExec);
    expect(toolPolicy({ ...guilds, "145": { tools: allowRead } })).toEqual(allowRead);
  },
);
