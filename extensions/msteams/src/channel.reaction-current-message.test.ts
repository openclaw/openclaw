import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { msteamsPlugin } from "./channel.js";

const { listReactionsMSTeamsMock, reactMessageMSTeamsMock } = vi.hoisted(() => ({
  listReactionsMSTeamsMock: vi.fn(),
  reactMessageMSTeamsMock: vi.fn(),
}));

vi.mock("./channel.runtime.js", () => ({
  msTeamsChannelRuntime: {
    listReactionsMSTeams: listReactionsMSTeamsMock,
    reactMessageMSTeams: reactMessageMSTeamsMock,
  },
}));

const cfg = {
  channels: { msteams: { groupPolicy: "open", dmPolicy: "open" } },
} as OpenClawConfig;
const currentChannelId = "conversation:19:current@thread.tacv2";
const currentMessageId = 1751234567890;

async function runAction(action: "react" | "reactions" | "delete", params = {}) {
  const handleAction = msteamsPlugin.actions?.handleAction;
  if (!handleAction) {
    throw new Error("msteams actions.handleAction unavailable");
  }
  return await handleAction({
    channel: "msteams",
    action,
    cfg,
    params,
    toolContext: {
      currentChannelProvider: "msteams",
      currentChannelId,
      currentChatType: "group",
      currentMessageId,
    },
  } as Parameters<typeof handleAction>[0]);
}

describe("msteams current-message reactions", () => {
  beforeEach(() => {
    listReactionsMSTeamsMock.mockReset();
    reactMessageMSTeamsMock.mockReset();
  });

  it.each([
    { action: "react" as const, params: { emoji: "like" }, mock: reactMessageMSTeamsMock },
    { action: "reactions" as const, params: {}, mock: listReactionsMSTeamsMock },
  ])("uses the inbound message id for $action", async ({ action, params, mock }) => {
    mock.mockResolvedValue(action === "react" ? { ok: true } : { reactions: [] });

    await expect(runAction(action, params)).resolves.not.toMatchObject({ isError: true });
    expect(mock).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg,
        to: currentChannelId,
        messageId: String(currentMessageId),
      }),
    );
  });

  it("requires an explicit message id for a different conversation", async () => {
    await expect(
      runAction("react", { to: "conversation:19:other@thread.tacv2", emoji: "like" }),
    ).resolves.toMatchObject({ isError: true });
    expect(reactMessageMSTeamsMock).not.toHaveBeenCalled();
  });

  it("does not apply the fallback to destructive actions", async () => {
    await expect(runAction("delete", { to: currentChannelId })).resolves.toMatchObject({
      isError: true,
    });
  });
});
