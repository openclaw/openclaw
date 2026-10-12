import type { ActionGate } from "openclaw/plugin-sdk/channel-actions";
import type { DiscordActionConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayPlugin } from "../internal/gateway.js";
import { clearGateways, registerGateway } from "../monitor/gateway-registry.js";
import { handleDiscordAction } from "./runtime.js";
import { handleDiscordPresenceAction } from "./runtime.presence.js";

const mockUpdatePresence = vi.fn();
const presenceEnabled: ActionGate<DiscordActionConfig> = (key) => key === "presence";
const defaultDiscordConfig: OpenClawConfig = {
  channels: { discord: { token: "test-token", actions: { presence: true } } },
};
function createMockGateway(connected = true): GatewayPlugin {
  return { isConnected: connected, updatePresence: mockUpdatePresence } as unknown as GatewayPlugin;
}
function setPresence(params: Record<string, unknown>, gate = presenceEnabled) {
  return handleDiscordPresenceAction("setPresence", params, gate, defaultDiscordConfig);
}

describe("handleDiscordPresenceAction", () => {
  beforeEach(() => {
    mockUpdatePresence.mockClear();
    clearGateways();
    registerGateway("default", createMockGateway());
  });

  it.each([
    {
      name: "mixed-case streaming activity with URL",
      params: {
        activityType: "StReAmInG",
        activityName: "My Stream",
        activityUrl: "https://twitch.tv/example",
      },
      activities: [{ name: "My Stream", type: 1, url: "https://twitch.tv/example" }],
    },
    {
      name: "streaming activity without URL",
      params: { accountId: "default", activityType: "streaming", activityName: "My Stream" },
      activities: [{ name: "My Stream", type: 1 }],
    },
    {
      name: "custom activity using state",
      params: { activityType: "custom", activityState: "Vibing" },
      activities: [{ name: "", type: 4, state: "Vibing" }],
    },
  ])("sets $name", async ({ params, activities }) => {
    const result = await setPresence(params);
    expect(mockUpdatePresence).toHaveBeenCalledWith({
      since: null,
      activities,
      status: "online",
      afk: false,
    });
    expect(result.details).toEqual({ ok: true, status: "online", activities });
  });

  it.each<[string, Record<string, unknown>, RegExp]>([
    ["invalid status", { status: "offline" }, /Invalid status/],
    [
      "inherited constructor activityType",
      { activityType: "constructor", activityName: "x" },
      /Invalid activityType/,
    ],
    ["missing activityType", { activityName: "My Game" }, /activityType is required/],
  ])("rejects %s before sending to the gateway", async (_name, params, error) => {
    await expect(setPresence(params)).rejects.toThrow(error);
    expect(mockUpdatePresence).not.toHaveBeenCalled();
  });

  it("respects presence gating", async () => {
    await expect(setPresence({ status: "online" }, () => false)).rejects.toThrow(/disabled/);
  });

  it.each([false, true])("rejects an unavailable gateway (registered: %s)", async (registered) => {
    clearGateways();
    if (registered) {
      registerGateway("default", createMockGateway(false));
    }
    await expect(setPresence({ status: "dnd" })).rejects.toThrow(
      registered ? /not connected/ : /not available/,
    );
  });

  it("routes the full presence action to the configured named default account", async () => {
    clearGateways();
    registerGateway("ops", createMockGateway());
    await handleDiscordAction(
      { action: "setPresence", status: "idle" },
      {
        channels: {
          discord: {
            actions: { presence: true },
            defaultAccount: "ops",
            accounts: { ops: { token: "ops-token" } },
          },
        },
      },
    );
    expect(mockUpdatePresence).toHaveBeenCalledWith({
      since: null,
      activities: [],
      status: "idle",
      afk: false,
    });
  });

  it("rejects unknown presence actions", async () => {
    await expect(
      handleDiscordPresenceAction("unknownAction", {}, presenceEnabled, defaultDiscordConfig),
    ).rejects.toThrow(/Unknown presence action/);
  });
});
