import { describe, expect, it, vi } from "vitest";
import { resolveMattermostReplyContext } from "./reply-context.js";

describe("resolveMattermostReplyContext", () => {
  it("hydrates body and bot sender for replies to bot-authored posts", async () => {
    const logVerboseMessage = vi.fn();

    const result = await resolveMattermostReplyContext({
      effectiveReplyToId: "post-123",
      currentPostId: "post-456",
      resolvePostInfo: async () => ({
        id: "post-123",
        user_id: "bot-1",
        message: "Original reply",
      }),
      resolveUserInfo: async () => null,
      botUserId: "bot-1",
      botUsername: "joe_nas",
      logVerboseMessage,
    });

    expect(result).toEqual({
      replyToBody: "Original reply",
      replyToSender: "@joe_nas",
    });
    expect(logVerboseMessage).toHaveBeenCalledWith(
      "mattermost: hydrated reply context post=post-123 hasBody=yes hasSender=yes",
    );
  });

  it("hydrates sender usernames for non-bot reply targets", async () => {
    const result = await resolveMattermostReplyContext({
      effectiveReplyToId: "post-123",
      currentPostId: "post-456",
      resolvePostInfo: async () => ({
        id: "post-123",
        user_id: "user-99",
        message: "Can you summarize this?",
      }),
      resolveUserInfo: async () => ({ id: "user-99", username: "tomradman" }),
      botUserId: "bot-1",
      botUsername: "joe_nas",
      logVerboseMessage: vi.fn(),
    });

    expect(result).toEqual({
      replyToBody: "Can you summarize this?",
      replyToSender: "@tomradman",
    });
  });

  it("skips hydration when the reply target is the current post", async () => {
    const resolvePostInfo = vi.fn();

    const result = await resolveMattermostReplyContext({
      effectiveReplyToId: "post-123",
      currentPostId: "post-123",
      resolvePostInfo,
      resolveUserInfo: async () => null,
      botUserId: "bot-1",
      botUsername: "joe_nas",
      logVerboseMessage: vi.fn(),
    });

    expect(result).toEqual({});
    expect(resolvePostInfo).not.toHaveBeenCalled();
  });
});
