import { afterEach, describe, expect, it, vi } from "vitest";
import { createMattermostReactionHandler } from "./monitor-reactions.js";
import {
  createLoopbackMonitorContext,
  LOOPBACK_CHANNEL_ID as CHANNEL_ID,
  LOOPBACK_SESSION_KEY as BASE_SESSION_KEY,
  withLoopbackMattermost,
} from "./monitor.loopback.test-support.js";

const enqueueSystemEvent = vi.fn();

afterEach(() => enqueueSystemEvent.mockClear());

async function runReaction(
  post: { id: string; user_id?: string; root_id?: string } | null,
  options: { postId?: string; reactionNotifications?: "off" | "own" | "all" },
) {
  const payloads: Record<string, unknown> = {
    [`/api/v4/channels/${CHANNEL_ID}`]: { id: CHANNEL_ID, name: "town-square", type: "O" },
    "/api/v4/users/user-1": { id: "user-1", username: "alice", update_at: 1 },
  };
  if (post) {
    payloads[`/api/v4/posts/${post.id}`] = { channel_id: CHANNEL_ID, ...post };
  }
  return await withLoopbackMattermost(payloads, async (baseUrl) => {
    const monitor = createLoopbackMonitorContext({
      baseUrl,
      enqueueSystemEvent,
      config: { groupPolicy: "open", reactionNotifications: options.reactionNotifications },
    });
    await createMattermostReactionHandler(monitor)({
      event: "reaction_added",
      data: {
        reaction: JSON.stringify({
          user_id: "user-1",
          post_id: options.postId ?? post?.id,
          emoji_name: "thumbsup",
        }),
        channel_id: CHANNEL_ID,
      },
      broadcast: post ? { channel_id: CHANNEL_ID } : undefined,
    });
  });
}

describe("mattermost reaction thread placement", () => {
  it.each([
    {
      post: { id: "post-reply", root_id: "root-1" },
      sessionKey: `${BASE_SESSION_KEY}:thread:root-1`,
    },
    { post: null, sessionKey: BASE_SESSION_KEY },
  ])("uses session $sessionKey after the production post lookup", async ({ post, sessionKey }) => {
    const postId = post?.id ?? "post-unknown";
    const requests = await runReaction(post, { postId, reactionNotifications: "all" });
    expect(requests).toContain(`GET /api/v4/posts/${postId}`);
    expect(enqueueSystemEvent).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("Mattermost reaction added"),
      expect.objectContaining({
        sessionKey,
        contextKey: `mattermost:reaction:${postId}:thumbsup:user-1:added`,
      }),
    );
  });
});

describe("mattermost reaction notification modes", () => {
  it.each([
    { mode: undefined, author: "bot-user", forwarded: true },
    { mode: undefined, author: "user-2", forwarded: true },
    { mode: "own" as const, author: "bot-user", forwarded: true },
    { mode: "own" as const, author: "user-2", forwarded: false },
    { mode: "all" as const, author: "user-2", forwarded: true },
    { mode: "off" as const, author: "bot-user", forwarded: false },
  ])(
    "reactionNotifications=$mode on a post by $author forwards=$forwarded",
    async ({ mode, author, forwarded }) => {
      await runReaction({ id: "post-mode", user_id: author }, { reactionNotifications: mode });
      expect(enqueueSystemEvent).toHaveBeenCalledTimes(forwarded ? 1 : 0);
    },
  );
});
