import { withNormalizedTimestamp } from "openclaw/plugin-sdk/channel-actions";
import type { MattermostClient, MattermostPost, MattermostUser } from "./client.js";

export type MattermostPostList = { order?: string[]; posts?: Record<string, MattermostPost> };

export function postListToMessages(list: MattermostPostList): MattermostPost[] {
  const posts = list.posts ?? {};
  return (list.order ?? Object.keys(posts)).flatMap((postId) => {
    const post = posts[postId];
    return post ? [post] : [];
  });
}

async function resolveMattermostUsernames(
  client: MattermostClient,
  messages: MattermostPost[],
): Promise<Map<string, string>> {
  const userIds = [...new Set(messages.flatMap((post) => (post.user_id ? [post.user_id] : [])))];
  if (userIds.length === 0) {
    return new Map();
  }
  const users = await client.request<MattermostUser[]>("/users/ids", {
    method: "POST",
    body: JSON.stringify(userIds),
  });
  return new Map(users.flatMap((user) => (user.username ? [[user.id, user.username]] : [])));
}

/**
 * Posts for `read`, `list-pins`, and `search` results. Raw Mattermost fields
 * (`id`, `channel_id`, `root_id`, `user_id`, `create_at`) stay for callers that
 * address posts; `content`, `user`, and `timestamp` are what the shared message
 * CLI prints. A user the lookup does not return keeps its id as `user`.
 */
export async function normalizeMattermostMessages(
  client: MattermostClient,
  messages: MattermostPost[],
): Promise<Record<string, unknown>[]> {
  const usernames = await resolveMattermostUsernames(client, messages);
  return messages.map((message) => {
    const normalized = withNormalizedTimestamp(message, message.create_at);
    const userId = message.user_id ?? undefined;
    return {
      ...normalized,
      content: message.message ?? "",
      user: (userId && usernames.get(userId)) || userId,
      timestamp: normalized.timestampUtc,
    };
  });
}
