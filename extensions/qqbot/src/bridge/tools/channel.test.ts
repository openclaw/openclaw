import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/core";
import { describe, expect, it, vi } from "vitest";
import { ensurePlatformAdapter } from "../bootstrap.js";
import { createChannelTool, registerChannelTool } from "./channel.js";

const account = {
  appId: "app-1",
  clientSecret: "secret-1",
};

describe("bridge/tools/channel", () => {
  it("marks qqbot_channel_api as owner-only", () => {
    const tool = createChannelTool(account);
    expect(tool.ownerOnly).toBe(true);
  });

  it("does not request an access token when sender ownership is missing", async () => {
    const getAccessToken = vi.fn(async () => "token-1");
    const executeChannelApi = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "{}" }],
      details: { ok: true },
    }));
    const tool = createChannelTool(account, {}, { getAccessToken, executeChannelApi });

    const result = await tool.execute("tool-call-1", {
      method: "GET",
      path: "/users/@me/guilds",
    });

    expect(getAccessToken).not.toHaveBeenCalled();
    expect(executeChannelApi).not.toHaveBeenCalled();
    expect(result.details).toEqual({
      error: "QQBot channel API requires an owner-authorized sender.",
    });
  });

  it("executes channel API calls for owner-authorized senders", async () => {
    const getAccessToken = vi.fn(async () => "token-1");
    const executeChannelApi = vi.fn(async () => ({
      content: [{ type: "text" as const, text: '{"success":true}' }],
      details: { success: true },
    }));
    const tool = createChannelTool(
      account,
      { senderIsOwner: true },
      { getAccessToken, executeChannelApi },
    );

    const params = { method: "GET", path: "/users/@me/guilds" };
    const result = await tool.execute("tool-call-1", params);

    expect(getAccessToken).toHaveBeenCalledWith("app-1", "secret-1");
    expect(executeChannelApi).toHaveBeenCalledWith(params, { accessToken: "token-1" });
    expect(result.details).toEqual({ success: true });
  });

  it("registers a context-aware channel API tool factory", async () => {
    const registerTool = vi.fn();
    const api = {
      config: {
        channels: {
          qqbot: {
            appId: "app-1",
            clientSecret: "secret-1",
          },
        },
      },
      registerTool,
    } as unknown as OpenClawPluginApi;

    ensurePlatformAdapter();
    registerChannelTool(api);

    expect(registerTool).toHaveBeenCalledWith(expect.any(Function), {
      name: "qqbot_channel_api",
    });
    const factory = registerTool.mock.calls[0]?.[0] as (
      ctx: OpenClawPluginToolContext,
    ) => AnyAgentTool;
    const tool = factory({});
    const result = await tool.execute("tool-call-1", {
      method: "GET",
      path: "/users/@me/guilds",
    });

    expect(tool.ownerOnly).toBe(true);
    expect(result.details).toEqual({
      error: "QQBot channel API requires an owner-authorized sender.",
    });
  });
});
