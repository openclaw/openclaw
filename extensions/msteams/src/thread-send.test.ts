import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import { sendThreadAdaptiveCardMSTeams, sendThreadMessageMSTeams } from "./thread-send.js";

const mockState = vi.hoisted(() => {
  const continueConversation = vi.fn(
    async (_appId: string, _ref: unknown, logic: (ctx: unknown) => Promise<void>) => {
      await logic({
        sendActivity: vi.fn(async () => ({ id: "activity-1" })),
        updateActivity: vi.fn(async () => ({ id: "updated" })),
        deleteActivity: vi.fn(async () => undefined),
      });
    },
  );
  return {
    sendMSTeamsMessages: vi.fn(async () => ["msg-1"]),
    continueConversation,
    resolveMSTeamsSendContext: vi.fn(async () => ({
      appId: "app-1",
      conversationId: "19:channel@thread.tacv2",
      ref: {
        activityId: "old-root",
        user: { id: "user-1", aadObjectId: "user-1", name: "Alex" },
        agent: { id: "bot-1", name: "Bot" },
        conversation: { id: "19:channel@thread.tacv2", conversationType: "channel" },
        channelId: "msteams",
      },
      adapter: {
        continueConversation,
      },
      log: {
        debug: vi.fn(),
        info: vi.fn(),
      },
      conversationType: "channel",
      tokenProvider: {
        getAccessToken: vi.fn(async () => "token"),
      },
      sharePointSiteId: undefined,
      mediaMaxBytes: undefined,
      graphChatId: null,
    })),
  };
});

vi.mock("./send-context.js", () => ({
  resolveMSTeamsSendContext: mockState.resolveMSTeamsSendContext,
}));

vi.mock("./messenger.js", async () => {
  const actual = await vi.importActual<typeof import("./messenger.js")>("./messenger.js");
  return {
    ...actual,
    sendMSTeamsMessages: mockState.sendMSTeamsMessages,
  };
});

describe("thread send helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends thread messages with replyStyle=thread and the requested root activity id", async () => {
    await sendThreadMessageMSTeams({
      cfg: {} as OpenClawConfig,
      conversationId: "19:channel@thread.tacv2",
      rootMessageId: "root-1",
      text: "Summary",
    });

    expect(mockState.sendMSTeamsMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        replyStyle: "thread",
        conversationRef: expect.objectContaining({
          activityId: "root-1",
          conversation: expect.objectContaining({
            id: "19:channel@thread.tacv2",
            conversationType: "channel",
          }),
        }),
      }),
    );
  });

  it("sends adaptive cards into the exact source thread conversation", async () => {
    await sendThreadAdaptiveCardMSTeams({
      cfg: {} as OpenClawConfig,
      conversationId: "19:channel@thread.tacv2",
      rootMessageId: "root-1",
      card: { type: "AdaptiveCard", version: "1.5", body: [] },
    });

    expect(mockState.continueConversation).toHaveBeenCalledWith(
      "app-1",
      expect.objectContaining({
        conversation: expect.objectContaining({
          id: "19:channel@thread.tacv2;messageid=root-1",
        }),
      }),
      expect.any(Function),
    );
  });
});
