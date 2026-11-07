import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../config/config.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { resolveGroupToolPolicy } from "./agent-tools.policy.js";

// Like Telegram, this roster also lists account ids that routing bindings name.
const listAccountIds = (config: OpenClawConfig) => [
  "default",
  ...Object.keys(config.channels?.whatsapp?.accounts ?? {}),
  ...(config.bindings ?? []).flatMap((binding) =>
    binding.match.channel === "whatsapp" && binding.match.accountId
      ? [binding.match.accountId]
      : [],
  ),
];

function useWhatsApp(config: Partial<ChannelPlugin["config"]>) {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "whatsapp",
        plugin: createChannelTestPluginBase({
          id: "whatsapp",
          config: { listAccountIds, ...config },
        }),
        source: "test",
      },
    ]),
  );
}

const route = (accountId: string) => ({
  agentId: "main",
  match: { channel: "whatsapp", accountId },
});
const params = {
  config: {
    channels: {
      whatsapp: { groups: { "safe-room": { tools: { allow: ["read"] } } }, accounts: { work: {} } },
    },
    bindings: [route("removed"), route("work")],
  } as OpenClawConfig,
  sessionKey: "agent:main:whatsapp:group:safe-room",
  requireConfiguredAccount: true,
};
const hasAccountConfig = (config: OpenClawConfig, accountId: string) =>
  Object.hasOwn(config.channels?.whatsapp?.accounts ?? {}, accountId);

describe("resolveGroupToolPolicy scheduled account configuration", () => {
  afterEach(() => resetPluginRuntimeStateForTest());

  it("rejects a removed account that a routing binding still lists", () => {
    const spy = vi.fn(hasAccountConfig);
    useWhatsApp({ hasAccountConfig: spy });
    expect(() => resolveGroupToolPolicy({ ...params, accountId: "unlisted" })).toThrow(
      'Scheduled account "unlisted" is unavailable',
    );
    expect(spy).not.toHaveBeenCalled();
    expect(() => resolveGroupToolPolicy({ ...params, accountId: "removed" })).toThrow(
      'Scheduled account "removed" is unavailable',
    );
    expect(resolveGroupToolPolicy({ ...params, accountId: "work" })).toEqual({ allow: ["read"] });
  });

  it("admits listed accounts when the channel has no account predicate", () => {
    useWhatsApp({});
    expect(resolveGroupToolPolicy({ ...params, accountId: "work" })).toEqual({ allow: ["read"] });
  });

  it.each([
    [
      "throws",
      () => {
        throw new Error("unreadable");
      },
    ],
    ["returns a non-boolean", () => undefined as unknown as boolean],
    ["returns a promise", () => Promise.resolve(true) as unknown as boolean],
  ])("rejects when the account predicate %s", (_case, predicate) => {
    useWhatsApp({ hasAccountConfig: predicate });
    expect(() => resolveGroupToolPolicy({ ...params, accountId: "work" })).toThrow(
      'Scheduled account "work" is unavailable',
    );
  });
});
