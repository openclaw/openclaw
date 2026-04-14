import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";

const mocks = vi.hoisted(() => ({
  sendMessageMSTeams: vi.fn(),
  sendPollMSTeams: vi.fn(),
  sendAdaptiveCardMSTeams: vi.fn(),
  createPoll: vi.fn(),
}));

vi.mock("./send.js", () => ({
  sendMessageMSTeams: mocks.sendMessageMSTeams,
  sendPollMSTeams: mocks.sendPollMSTeams,
  sendAdaptiveCardMSTeams: mocks.sendAdaptiveCardMSTeams,
}));

vi.mock("./polls.js", () => ({
  createMSTeamsPollStoreFs: () => ({
    createPoll: mocks.createPoll,
  }),
}));

import { msteamsOutbound } from "./outbound.js";

describe("msteamsOutbound cfg threading", () => {
  beforeEach(() => {
    mocks.sendMessageMSTeams.mockReset();
    mocks.sendPollMSTeams.mockReset();
    mocks.sendAdaptiveCardMSTeams.mockReset();
    mocks.createPoll.mockReset();
    mocks.sendMessageMSTeams.mockResolvedValue({
      messageId: "msg-1",
      conversationId: "conv-1",
    });
    mocks.sendPollMSTeams.mockResolvedValue({
      pollId: "poll-1",
      messageId: "msg-poll-1",
      conversationId: "conv-1",
    });
    mocks.sendAdaptiveCardMSTeams.mockResolvedValue({
      messageId: "msg-card-1",
      conversationId: "conv-1",
    });
    mocks.createPoll.mockResolvedValue(undefined);
  });

  it("passes resolved cfg to sendMessageMSTeams for text sends", async () => {
    const cfg = {
      channels: {
        msteams: {
          appId: "resolved-app-id",
        },
      },
    } as OpenClawConfig;

    await msteamsOutbound.sendText!({
      cfg,
      to: "conversation:abc",
      text: "hello",
    });

    expect(mocks.sendMessageMSTeams).toHaveBeenCalledWith({
      cfg,
      to: "conversation:abc",
      text: "hello",
    });
  });

  it("passes resolved cfg and media roots for media sends", async () => {
    const cfg = {
      channels: {
        msteams: {
          appId: "resolved-app-id",
        },
      },
    } as OpenClawConfig;

    await msteamsOutbound.sendMedia!({
      cfg,
      to: "conversation:abc",
      text: "photo",
      mediaUrl: "file:///tmp/photo.png",
      mediaLocalRoots: ["/tmp"],
    });

    expect(mocks.sendMessageMSTeams).toHaveBeenCalledWith({
      cfg,
      to: "conversation:abc",
      text: "photo",
      mediaUrl: "file:///tmp/photo.png",
      mediaLocalRoots: ["/tmp"],
    });
  });

  it("passes resolved cfg to sendPollMSTeams and stores poll metadata", async () => {
    const cfg = {
      channels: {
        msteams: {
          appId: "resolved-app-id",
        },
      },
    } as OpenClawConfig;

    await msteamsOutbound.sendPoll!({
      cfg,
      to: "conversation:abc",
      poll: {
        question: "Snack?",
        options: ["Pizza", "Sushi"],
      },
    });

    expect(mocks.sendPollMSTeams).toHaveBeenCalledWith({
      cfg,
      to: "conversation:abc",
      question: "Snack?",
      options: ["Pizza", "Sushi"],
      maxSelections: 1,
    });
    expect(mocks.createPoll).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "poll-1",
        question: "Snack?",
        options: ["Pizza", "Sushi"],
      }),
    );
  });

  it("chunks outbound text without requiring MSTeams runtime initialization", () => {
    const chunker = msteamsOutbound.chunker;
    if (!chunker) {
      throw new Error("msteams outbound.chunker unavailable");
    }

    expect(chunker("alpha beta", 5)).toEqual(["alpha", "beta"]);
  });

  it("sendPayload renders interactive buttons as Adaptive Card with messageBack", async () => {
    const cfg = {
      channels: { msteams: { appId: "app-id" } },
    } as OpenClawConfig;

    await msteamsOutbound.sendPayload!({
      cfg,
      to: "conversation:abc",
      text: "",
      payload: {
        text: "Approve this plugin?",
        interactive: {
          blocks: [
            {
              type: "buttons",
              buttons: [
                { label: "Approve", value: "/approve abc123 yes", style: "primary" },
                { label: "Deny", value: "/approve abc123 no", style: "danger" },
              ],
            },
          ],
        },
      },
    });

    expect(mocks.sendAdaptiveCardMSTeams).toHaveBeenCalledOnce();
    const call = mocks.sendAdaptiveCardMSTeams.mock.calls[0][0];
    expect(call.cfg).toBe(cfg);
    expect(call.to).toBe("conversation:abc");

    const card = call.card;
    expect(card.type).toBe("AdaptiveCard");
    expect(card.body).toEqual([
      { type: "TextBlock", text: "Approve this plugin?", wrap: true },
    ]);
    expect(card.actions).toHaveLength(2);
    expect(card.actions[0].title).toBe("Approve");
    expect(card.actions[0].data.msteams.type).toBe("messageBack");
    expect(card.actions[0].data.msteams.text).toBe("/approve abc123 yes");
    expect(card.actions[0].data.msteams.displayText).toBe("Approve");
    expect(card.actions[0].style).toBe("positive");
    expect(card.actions[1].style).toBe("destructive");
  });

  it("sendPayload falls back to sendText when no interactive buttons present", async () => {
    const cfg = {
      channels: { msteams: { appId: "app-id" } },
    } as OpenClawConfig;

    await msteamsOutbound.sendPayload!({
      cfg,
      to: "conversation:abc",
      text: "plain message",
      payload: {
        text: "plain message",
      },
    });

    expect(mocks.sendAdaptiveCardMSTeams).not.toHaveBeenCalled();
    expect(mocks.sendMessageMSTeams).toHaveBeenCalledOnce();
  });

  it("sendPayload sends pre-built channelData card directly", async () => {
    const cfg = {
      channels: { msteams: { appId: "app-id" } },
    } as OpenClawConfig;

    const prebuiltCard = {
      type: "AdaptiveCard",
      version: "1.5",
      body: [{ type: "TextBlock", text: "Custom card" }],
    };

    await msteamsOutbound.sendPayload!({
      cfg,
      to: "conversation:abc",
      text: "",
      payload: {
        text: "",
        channelData: { msteams: { card: prebuiltCard } },
      },
    });

    expect(mocks.sendAdaptiveCardMSTeams).toHaveBeenCalledWith({
      cfg,
      to: "conversation:abc",
      card: prebuiltCard,
    });
  });
});
