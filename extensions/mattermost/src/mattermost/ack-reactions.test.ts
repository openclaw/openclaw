import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "./runtime-api.js";

const mockState = vi.hoisted(() => ({
  addMattermostReaction: vi.fn(),
  removeMattermostReaction: vi.fn(),
}));

vi.mock("./reactions.js", async () => {
  const actual = await vi.importActual<typeof import("./reactions.js")>("./reactions.js");
  return {
    ...actual,
    addMattermostReaction: mockState.addMattermostReaction,
    removeMattermostReaction: mockState.removeMattermostReaction,
  };
});

import {
  cleanupMattermostAckReaction,
  createMattermostAckReaction,
  resolveMattermostAckReactionConfig,
} from "./ack-reactions.js";

describe("mattermost ack reactions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.addMattermostReaction.mockResolvedValue({ ok: true });
    mockState.removeMattermostReaction.mockResolvedValue({ ok: true });
  });

  it("resolves account ackReaction overrides and normalizes unicode emoji", () => {
    const cfg: OpenClawConfig = {
      messages: {
        ackReaction: "👀",
        ackReactionScope: "all",
        removeAckAfterReply: true,
      },
      channels: {
        mattermost: {
          ackReaction: "✅",
          accounts: {
            default: {
              ackReaction: "👍",
            },
          },
        },
      },
    };

    expect(
      resolveMattermostAckReactionConfig({
        cfg,
        agentId: "main",
        accountId: "default",
      }),
    ).toEqual({
      ackReaction: "thumbsup",
      ackReactionScope: "all",
      removeAckAfterReply: true,
    });
  });

  it("creates and removes an ack reaction after a delivered reply", async () => {
    const cfg: OpenClawConfig = {
      messages: {
        ackReaction: "👀",
        ackReactionScope: "all",
        removeAckAfterReply: true,
      },
      channels: {
        mattermost: {
          enabled: true,
          botToken: "bot-token",
          baseUrl: "https://mattermost.example.com",
        },
      },
    };

    const ackReaction = createMattermostAckReaction({
      cfg,
      agentId: "main",
      accountId: "default",
      channelId: "chan-1",
      postId: "post-1",
      kind: "channel",
      shouldRequireMention: false,
      canDetectMention: true,
      effectiveWasMentioned: false,
      shouldBypassMention: false,
      reactionsEnabled: true,
      log: vi.fn(),
    });

    expect(ackReaction).not.toBeNull();
    await ackReaction?.ackReactionPromise;
    expect(mockState.addMattermostReaction).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "default",
        postId: "post-1",
        emojiName: "eyes",
      }),
    );

    cleanupMattermostAckReaction({
      ackReaction,
      didSendReply: true,
      removeAckAfterReply: true,
      target: "chan-1/post-1",
      log: vi.fn(),
    });

    await vi.waitFor(() => {
      expect(mockState.removeMattermostReaction).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: "default",
          postId: "post-1",
          emojiName: "eyes",
        }),
      );
    });
  });

  it("skips mention-scoped acks when the channel does not require mentions", () => {
    const cfg: OpenClawConfig = {
      messages: {
        ackReaction: "👀",
        ackReactionScope: "group-mentions",
      },
      channels: {
        mattermost: {
          enabled: true,
          botToken: "bot-token",
          baseUrl: "https://mattermost.example.com",
        },
      },
    };

    const ackReaction = createMattermostAckReaction({
      cfg,
      agentId: "main",
      accountId: "default",
      channelId: "chan-1",
      postId: "post-1",
      kind: "channel",
      shouldRequireMention: false,
      canDetectMention: true,
      effectiveWasMentioned: false,
      shouldBypassMention: false,
      reactionsEnabled: true,
      log: vi.fn(),
    });

    expect(ackReaction).toBeNull();
    expect(mockState.addMattermostReaction).not.toHaveBeenCalled();
  });

  it("does not remove the ack reaction when no reply was delivered", async () => {
    const cfg: OpenClawConfig = {
      messages: {
        ackReaction: "👀",
        ackReactionScope: "all",
        removeAckAfterReply: true,
      },
      channels: {
        mattermost: {
          enabled: true,
          botToken: "bot-token",
          baseUrl: "https://mattermost.example.com",
        },
      },
    };

    const ackReaction = createMattermostAckReaction({
      cfg,
      agentId: "main",
      accountId: "default",
      channelId: "chan-1",
      postId: "post-1",
      kind: "channel",
      shouldRequireMention: false,
      canDetectMention: true,
      effectiveWasMentioned: false,
      shouldBypassMention: false,
      reactionsEnabled: true,
      log: vi.fn(),
    });

    await ackReaction?.ackReactionPromise;
    cleanupMattermostAckReaction({
      ackReaction,
      didSendReply: false,
      removeAckAfterReply: true,
      target: "chan-1/post-1",
      log: vi.fn(),
    });

    await Promise.resolve();
    expect(mockState.removeMattermostReaction).not.toHaveBeenCalled();
  });
});
