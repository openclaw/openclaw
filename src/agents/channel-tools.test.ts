import { afterEach, describe, expect, it, vi } from "vitest";
import { runMessageActionDiscoveryAsync } from "../channels/plugins/message-action-discovery.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { defaultRuntime } from "../runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { listChannelSupportedActionsSteps } from "./channel-tools.js";

const EMPTY_PREPARED_MESSAGE_TOOL_CATALOG = {
  version: 0,
  channels: [],
  getChannel: () => undefined,
} as const;

function registerPlugin(id: string, overrides: Partial<ChannelPlugin> = {}, aliases?: string[]) {
  const plugin: ChannelPlugin = {
    id,
    meta: { id, label: id, selectionLabel: id, docsPath: `/channels/${id}`, blurb: id, aliases },
    capabilities: { chatTypes: ["direct"] },
    config: { listAccountIds: () => [], resolveAccount: () => ({}) },
    ...overrides,
  };
  setActivePluginRegistry(createTestRegistry([{ pluginId: id, source: "test", plugin }]));
}

function discover(
  channel = "test",
  preparedMessageToolCatalog?: Parameters<
    typeof listChannelSupportedActionsSteps
  >[0]["preparedMessageToolCatalog"],
) {
  return runMessageActionDiscoveryAsync(
    listChannelSupportedActionsSteps({ cfg: {}, channel, preparedMessageToolCatalog }),
  );
}

describe("channel tools", () => {
  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });

  it("keeps an explicitly empty prepared catalog authoritative", async () => {
    const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
    registerPlugin("test", {
      actions: {
        describeMessageTool: () => {
          throw new Error("boom");
        },
      },
    });
    expect(await discover("test", EMPTY_PREPARED_MESSAGE_TOOL_CATALOG)).toEqual([]);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("does not infer poll actions from outbound adapters when action discovery omits them", async () => {
    registerPlugin("polltest", {
      capabilities: { chatTypes: ["direct"], polls: true },
      actions: { describeMessageTool: () => ({ actions: [] }) },
      outbound: {
        deliveryMode: "gateway",
        sendPoll: async () => ({ channel: "polltest", messageId: "poll-1" }),
      },
    });
    expect(await discover("polltest")).toStrictEqual([]);
  });

  it("normalizes channel aliases before listing supported actions", async () => {
    registerPlugin(
      "telegram",
      { actions: { describeMessageTool: () => ({ actions: ["react"] }) } },
      ["tg"],
    );
    expect(await discover("tg")).toEqual(["react"]);
  });
});
