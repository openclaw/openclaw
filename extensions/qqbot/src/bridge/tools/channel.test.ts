import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
// QQBot tests cover channel API account selection behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerPlatformAdapter, type PlatformAdapter } from "../../engine/adapter/index.js";
import { registerChannelTool } from "./channel.js";

const executeChannelApiMock = vi.hoisted(() => vi.fn(async () => ({ details: {} })));
const getAccessTokenMock = vi.hoisted(() => vi.fn(async () => "access-token"));

vi.mock("../../engine/tools/channel-api.js", () => ({
  ChannelApiSchema: {},
  executeChannelApi: executeChannelApiMock,
}));

vi.mock("../../engine/messaging/sender.js", () => ({
  getAccessToken: getAccessTokenMock,
}));

type ChannelTool = {
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ details: unknown }>;
};

function resolveChannelTool(params: {
  config: OpenClawPluginApi["config"];
  agentAccountId?: string;
}): ChannelTool {
  const registerTool = vi.fn();
  registerChannelTool({ config: params.config, registerTool } as OpenClawPluginApi);
  const registration = registerTool.mock.calls[0]?.[0] as (ctx: {
    agentAccountId?: string;
  }) => ChannelTool;
  return registration({ agentAccountId: params.agentAccountId });
}

function createConfig(params: { enabledA?: boolean; enabledB?: boolean; hasSecretA?: boolean }) {
  return {
    channels: {
      qqbot: {
        accounts: {
          a: {
            appId: "app-a",
            ...(params.hasSecretA === false ? {} : { clientSecret: "secret-a" }), // pragma: allowlist secret
            enabled: params.enabledA,
          },
          b: {
            appId: "app-b",
            clientSecret: "secret-b", // pragma: allowlist secret
            enabled: params.enabledB,
          },
        },
      },
    },
  } as OpenClawPluginApi["config"];
}

describe("registerChannelTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerPlatformAdapter({
      hasConfiguredSecret: (value) => typeof value === "string" && value.length > 0,
      normalizeSecretInputString: (value) => (typeof value === "string" ? value : undefined),
      resolveSecretInputString: ({ value }) => (typeof value === "string" ? value : undefined),
    } as PlatformAdapter);
  });

  it("uses a credentialed account when no contextual account is available", async () => {
    const tool = resolveChannelTool({ config: createConfig({ hasSecretA: false }) });

    await tool.execute("call", { method: "GET", path: "/users/@me/guilds" });

    expect(getAccessTokenMock).toHaveBeenCalledWith("app-b", "secret-b");
  });

  it("routes the channel API token request to the contextual account", async () => {
    const tool = resolveChannelTool({ config: createConfig({}), agentAccountId: "b" });

    await tool.execute("call", { method: "GET", path: "/users/@me/guilds" });

    expect(getAccessTokenMock).toHaveBeenCalledWith("app-b", "secret-b");
  });

  it("does not fall back to another account when the contextual account is disabled", async () => {
    const tool = resolveChannelTool({
      config: createConfig({ enabledA: true, enabledB: false }),
      agentAccountId: "b",
    });

    const result = await tool.execute("call", { method: "GET", path: "/users/@me/guilds" });

    expect(result.details).toEqual({
      error: 'QQBot Channel API is not configured for account "b"',
    });
    expect(getAccessTokenMock).not.toHaveBeenCalled();
  });
});
