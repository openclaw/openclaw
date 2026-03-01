import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { resolveMattermostAccount } from "./accounts.js";
import {
  createMattermostClient,
  fetchMattermostChannelPosts,
  fetchMattermostUser,
  type MattermostPost,
} from "./client.js";

export type MattermostMessageSummary = {
  id: string;
  userId: string;
  username?: string;
  message: string;
  createAt: number;
  type?: string;
  rootId?: string;
  channelId?: string;
};

/**
 * Read messages from a Mattermost channel, resolving usernames for display.
 */
export async function readMattermostMessages(params: {
  cfg: OpenClawConfig;
  channelId: string;
  limit?: number;
  before?: string;
  after?: string;
  accountId?: string | null;
  fetchImpl?: typeof fetch;
}): Promise<{ messages: MattermostMessageSummary[]; hasMore: boolean }> {
  const resolved = resolveMattermostAccount({ cfg: params.cfg, accountId: params.accountId });
  const baseUrl = resolved.baseUrl?.trim();
  const botToken = resolved.botToken?.trim();
  if (!baseUrl || !botToken) {
    throw new Error("Mattermost botToken/baseUrl missing.");
  }

  const client = createMattermostClient({
    baseUrl,
    botToken,
    fetchImpl: params.fetchImpl,
  });

  const result = await fetchMattermostChannelPosts(client, params.channelId, {
    limit: params.limit,
    before: params.before,
    after: params.after,
  });

  // Resolve usernames (cache within this call to avoid duplicate lookups).
  const usernameCache = new Map<string, string>();
  const resolveUsername = async (userId: string): Promise<string | undefined> => {
    if (!userId) return undefined;
    const cached = usernameCache.get(userId);
    if (cached !== undefined) return cached;
    try {
      const user = await fetchMattermostUser(client, userId);
      const name = user.username ?? user.nickname ?? user.first_name ?? undefined;
      if (name) usernameCache.set(userId, name);
      return name ?? undefined;
    } catch {
      return undefined;
    }
  };

  const messages: MattermostMessageSummary[] = [];
  for (const post of result.messages) {
    const username = await resolveUsername(post.user_id ?? "");
    messages.push(postToSummary(post, username));
  }

  return { messages, hasMore: result.hasMore };
}

function postToSummary(post: MattermostPost, username?: string): MattermostMessageSummary {
  return {
    id: post.id,
    userId: post.user_id ?? "",
    ...(username ? { username } : {}),
    message: post.message ?? "",
    createAt: post.create_at ?? 0,
    ...(post.type ? { type: post.type } : {}),
    ...(post.root_id ? { rootId: post.root_id } : {}),
    ...(post.channel_id ? { channelId: post.channel_id } : {}),
  };
}
