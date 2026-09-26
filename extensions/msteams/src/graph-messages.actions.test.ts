// Msteams tests cover graph messages.actions plugin behavior.
import { beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import {
  CHANNEL_TO,
  CHAT_ID,
  TOKEN,
  type GraphMessagesTestModule,
  getGraphMessagesMockState,
  installGraphMessagesMockDefaults,
  loadGraphMessagesTestModule,
} from "./graph-messages.test-helpers.js";

const mockState = getGraphMessagesMockState();
installGraphMessagesMockDefaults();
let pinMessageMSTeams: GraphMessagesTestModule["pinMessageMSTeams"];
let reactMessageMSTeams: GraphMessagesTestModule["reactMessageMSTeams"];
let unpinMessageMSTeams: GraphMessagesTestModule["unpinMessageMSTeams"];
let unreactMessageMSTeams: GraphMessagesTestModule["unreactMessageMSTeams"];

beforeAll(async () => {
  ({ pinMessageMSTeams, reactMessageMSTeams, unpinMessageMSTeams, unreactMessageMSTeams } =
    await loadGraphMessagesTestModule());
});

describe("MSTeams reaction validation", () => {
  it.each(["react", "unreact"])("%s rejects empty reaction type", async (operation) => {
    const invoke = operation === "react" ? reactMessageMSTeams : unreactMessageMSTeams;
    await expect(
      invoke({
        cfg: {},
        to: CHAT_ID,
        messageId: "msg-1",
        reactionType: "   ",
      }),
    ).rejects.toThrow(/Reaction type is required/);
  });
});

describe("pinMessageMSTeams", () => {
  it("pins a message in a chat via message@odata.bind body", async () => {
    mockState.mutateGraphJson.mockResolvedValue({ id: "pinned-1" });

    const result = await pinMessageMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      messageId: "msg-1",
    });

    expect(result).toEqual({ ok: true, pinnedMessageId: "pinned-1" });
    expect(mockState.mutateGraphJson).toHaveBeenCalledWith({
      token: TOKEN,
      path: `/chats/${encodeURIComponent(CHAT_ID)}/pinnedMessages`,
      method: "POST",
      body: {
        "message@odata.bind": `https://graph.microsoft.com/v1.0/chats/${encodeURIComponent(
          CHAT_ID,
        )}/messages/${encodeURIComponent("msg-1")}`,
      },
    });
  });

  it("rejects pinning a message in a channel on Graph v1.0", async () => {
    await expect(
      pinMessageMSTeams({
        cfg: {} as OpenClawConfig,
        to: CHANNEL_TO,
        messageId: "msg-2",
      }),
    ).rejects.toThrow(/Pin\/unpin is not supported for channel messages/);
    expect(mockState.mutateGraphJson).not.toHaveBeenCalled();
  });
});

describe("unpinMessageMSTeams", () => {
  it("unpins a message from a chat", async () => {
    mockState.deleteGraphRequest.mockResolvedValue(undefined);

    const result = await unpinMessageMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      pinnedMessageId: "pinned-1",
    });

    expect(result).toEqual({ ok: true });
    expect(mockState.deleteGraphRequest).toHaveBeenCalledWith({
      token: TOKEN,
      path: `/chats/${encodeURIComponent(CHAT_ID)}/pinnedMessages/${encodeURIComponent("pinned-1")}`,
    });
  });

  it("rejects unpinning a message from a channel on Graph v1.0", async () => {
    await expect(
      unpinMessageMSTeams({
        cfg: {} as OpenClawConfig,
        to: CHANNEL_TO,
        pinnedMessageId: "pinned-2",
      }),
    ).rejects.toThrow(/Pin\/unpin is not supported for channel messages/);
    expect(mockState.deleteGraphRequest).not.toHaveBeenCalled();
  });
});

describe("MSTeams reactions", () => {
  it.each([
    {
      operation: "react",
      to: CHAT_ID,
      path: `/chats/${encodeURIComponent(CHAT_ID)}`,
      reactionType: " LAUGH ",
      expected: "😆",
      action: "setReaction",
    },
    {
      operation: "react",
      to: CHANNEL_TO,
      path: "/teams/team-id-1/channels/channel-id-1",
      reactionType: " 🎉 ",
      expected: "🎉",
      action: "setReaction",
    },
    {
      operation: "unreact",
      to: CHAT_ID,
      path: `/chats/${encodeURIComponent(CHAT_ID)}`,
      reactionType: " LAUGH ",
      expected: "😆",
      action: "unsetReaction",
    },
    {
      operation: "unreact",
      to: CHANNEL_TO,
      path: "/teams/team-id-1/channels/channel-id-1",
      reactionType: " 🎉 ",
      expected: "🎉",
      action: "unsetReaction",
    },
  ])(
    "$operation normalizes $reactionType for $to",
    async ({ operation, to, path, reactionType, expected, action }) => {
      mockState.mutateGraphJson.mockResolvedValue(undefined);
      const invoke = operation === "react" ? reactMessageMSTeams : unreactMessageMSTeams;
      await expect(invoke({ cfg: {}, to, messageId: "msg-1", reactionType })).resolves.toEqual({
        ok: true,
      });
      expect(mockState.resolveGraphToken).toHaveBeenCalledWith({}, { preferDelegated: true });
      expect(mockState.mutateGraphJson).toHaveBeenCalledWith({
        token: TOKEN,
        path: `${path}/messages/msg-1/${action}`,
        method: "POST",
        body: { reactionType: expected },
        beta: true,
      });
    },
  );

  it("resolves user: target through conversation store", async () => {
    mockState.findPreferredDmByUserId.mockResolvedValue({
      conversationId: "19:dm-chat@thread.tacv2",
      reference: {},
    });
    mockState.mutateGraphJson.mockResolvedValue(undefined);

    await reactMessageMSTeams({
      cfg: {} as OpenClawConfig,
      to: "user:aad-user-1",
      messageId: "msg-1",
      reactionType: "like",
    });

    expect(mockState.findPreferredDmByUserId).toHaveBeenCalledWith("aad-user-1");
    expect(mockState.mutateGraphJson).toHaveBeenCalledWith({
      token: TOKEN,
      path: `/chats/${encodeURIComponent("19:dm-chat@thread.tacv2")}/messages/msg-1/setReaction`,
      method: "POST",
      body: { reactionType: "👍" },
      beta: true,
    });
  });
});
