import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it, vi } from "vitest";

const handleDiscordMessageActionMock = vi.hoisted(() => vi.fn(async () => ({ ok: true })));

vi.mock("./actions/handle-action.js", () => ({
  handleDiscordMessageAction: handleDiscordMessageActionMock,
}));

import { discordMessageActions } from "./channel-actions.js";

describe("discordMessageActions", () => {
  it("returns no tool actions when no token-sourced Discord accounts are enabled", () => {
    const discovery = discordMessageActions.describeMessageTool?.({
      cfg: {
        channels: {
          discord: {
            enabled: true,
          },
        },
      } as OpenClawConfig,
    });

    expect(discovery).toEqual({
      actions: [],
      capabilities: [],
      schema: null,
    });
  });

  it("describes enabled Discord actions for token-backed accounts", () => {
    const discovery = discordMessageActions.describeMessageTool?.({
      cfg: {
        channels: {
          discord: {
            token: "Bot token-main",
            actions: {
              polls: true,
              reactions: true,
              permissions: true,
              channels: false,
              roles: false,
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(discovery?.capabilities).toEqual(["interactive", "components"]);
    expect(discovery?.schema).not.toBeNull();
    expect(discovery?.actions).toEqual(
      expect.arrayContaining(["send", "poll", "react", "reactions", "emoji-list", "permissions"]),
    );
    expect(discovery?.actions).not.toContain("channel-create");
    expect(discovery?.actions).not.toContain("role-add");
  });

  it("extracts send targets for message and thread reply actions", () => {
    expect(
      discordMessageActions.extractToolSend?.({
        args: { action: "sendMessage", to: "channel:123" },
      }),
    ).toEqual({ to: "channel:123" });

    expect(
      discordMessageActions.extractToolSend?.({
        args: { action: "threadReply", channelId: "987" },
      }),
    ).toEqual({ to: "channel:987" });

    expect(
      discordMessageActions.extractToolSend?.({
        args: { action: "threadReply", channelId: "   " },
      }),
    ).toBeNull();
  });

  it("delegates action handling to the Discord action handler", async () => {
    const cfg = {
      channels: {
        discord: {
          token: "Bot token-main",
        },
      },
    } as OpenClawConfig;
    const toolContext: ChannelMessageActionContext["toolContext"] = {
      currentChannelProvider: "discord",
    };
    const mediaLocalRoots = ["/tmp/media"];

    await discordMessageActions.handleAction?.({
      channel: "discord",
      action: "send",
      params: { to: "channel:123", text: "hello" },
      cfg,
      accountId: "ops",
      requesterSenderId: "user-1",
      toolContext,
      mediaLocalRoots,
    });

    expect(handleDiscordMessageActionMock).toHaveBeenCalledWith({
      channel: "discord",
      action: "send",
      params: { to: "channel:123", text: "hello" },
      cfg,
      accountId: "ops",
      requesterSenderId: "user-1",
      toolContext,
      mediaLocalRoots,
    });
  });
});
