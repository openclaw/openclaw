import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import { normalizeMattermostMessagingTarget } from "../normalize.js";
import { resolveMattermostAccount } from "./accounts.js";
import {
  createMattermostClient,
  fetchMattermostChannel,
  fetchMattermostMe,
  type MattermostClient,
  type MattermostPost,
} from "./client.js";
import type { OpenClawConfig } from "./runtime-api.js";

type ConversationReadInvocationOrigin = NonNullable<
  ChannelMessageActionContext["conversationReadOrigin"]
>;
type Result = { ok: true } | { ok: false; error: string };
type ReactionParams = {
  cfg: OpenClawConfig;
  postId: string;
  emojiName: string;
  accountId?: string | null;
  authorizedTarget?: string;
  conversationReadOrigin?: ConversationReadInvocationOrigin;
  /** Host-owned caller authority, rechecked by the client before every request. */
  assertDirectAdapterHandoff?: () => void;
};

const BOT_USER_CACHE_TTL_MS = 10 * 60_000;
const botUserIdCache = new Map<string, { userId: string; expiresAt: number }>();

async function resolveBotUserId(
  client: MattermostClient,
  cacheKey: string,
): Promise<string | null> {
  const now = Date.now();
  const cached = botUserIdCache.get(cacheKey);
  if (cached) {
    if (cached.expiresAt > now) {
      return cached.userId;
    }
    botUserIdCache.delete(cacheKey);
  }
  const me = await fetchMattermostMe(client);
  const userId = me?.id?.trim();
  if (!userId) {
    return null;
  }
  botUserIdCache.set(cacheKey, { userId, expiresAt: now + BOT_USER_CACHE_TTL_MS });
  return userId;
}

export async function addMattermostReaction(params: ReactionParams): Promise<Result> {
  return runMattermostReaction(params, "add");
}

export async function removeMattermostReaction(params: ReactionParams): Promise<Result> {
  return runMattermostReaction(params, "remove");
}

type AuthorizedReactionTarget = { kind: "channel"; id: string } | { kind: "user"; id: string };

/**
 * Delegated post actions (react, edit, delete, pin) may only touch posts inside the
 * conversation the runner authorized: the same channel, or the DM with that user.
 */
export async function authorizeMattermostPostForConversation(params: {
  client: MattermostClient;
  postId: string;
  authorizedTarget?: string;
  cacheKey: string;
  label?: string;
}): Promise<{ post: MattermostPost; botUserId?: string }> {
  const label = params.label ?? "reaction";
  const target = parseAuthorizedReactionTarget(params.authorizedTarget);
  if (!target) {
    throw new Error(
      `Mattermost delegated ${label}s require a canonical authorized conversation target.`,
    );
  }
  const post = await params.client.request<MattermostPost>(
    `/posts/${encodeURIComponent(params.postId)}`,
  );
  const postChannelId = post.channel_id?.trim();
  if (!postChannelId) {
    throw new Error(`Mattermost ${label} post is missing its conversation binding.`);
  }
  if (target.kind === "channel") {
    if (postChannelId !== target.id) {
      throw new Error(`Mattermost ${label} post belongs to a different conversation.`);
    }
    return { post };
  }
  const botUserId = await resolveBotUserId(params.client, params.cacheKey);
  if (!botUserId) {
    throw new Error(`Mattermost ${label}s failed: could not resolve bot user id.`);
  }
  const channel = await fetchMattermostChannel(params.client, postChannelId);
  // Keep both slots: Mattermost permits self-DMs, so a Set would collapse the
  // duplicate IDs and could authorize a different peer's conversation.
  const participants =
    channel.name
      ?.split("__")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .toSorted() ?? [];
  const authorizedParticipants = [botUserId, target.id].toSorted();
  if (
    channel.type !== "D" ||
    participants.length !== 2 ||
    participants[0] !== authorizedParticipants[0] ||
    participants[1] !== authorizedParticipants[1]
  ) {
    throw new Error(`Mattermost ${label} post belongs to a different direct conversation.`);
  }
  return { post, botUserId };
}

export { resolveBotUserId as resolveMattermostBotUserId };

function parseAuthorizedReactionTarget(rawTarget?: string): AuthorizedReactionTarget | null {
  const normalized = rawTarget ? normalizeMattermostMessagingTarget(rawTarget) : undefined;
  if (!normalized) {
    return null;
  }
  if (normalized.startsWith("channel:")) {
    const id = normalized.slice("channel:".length).trim();
    return id ? { kind: "channel", id } : null;
  }
  if (normalized.startsWith("user:")) {
    const id = normalized.slice("user:".length).trim();
    return id ? { kind: "user", id } : null;
  }
  return null;
}

async function runMattermostReaction(
  params: ReactionParams,
  action: "add" | "remove",
): Promise<Result> {
  const resolved = resolveMattermostAccount({ cfg: params.cfg, accountId: params.accountId });
  const baseUrl = resolved.baseUrl?.trim();
  const botToken = resolved.botToken?.trim();
  if (!baseUrl || !botToken) {
    return { ok: false, error: "Mattermost botToken/baseUrl missing." };
  }

  const client = createMattermostClient({
    baseUrl,
    botToken,
    allowPrivateNetwork: resolved.config.network?.dangerouslyAllowPrivateNetwork === true,
    assertRequestCurrent: params.assertDirectAdapterHandoff,
  });

  const cacheKey = `${baseUrl}:${botToken}`;
  try {
    const authorizedUserId =
      params.conversationReadOrigin === "direct-operator"
        ? undefined
        : (
            await authorizeMattermostPostForConversation({
              client,
              postId: params.postId,
              authorizedTarget: params.authorizedTarget,
              cacheKey,
            })
          ).botUserId;
    const userId = authorizedUserId ?? (await resolveBotUserId(client, cacheKey));
    if (!userId) {
      return { ok: false, error: "Mattermost reactions failed: could not resolve bot user id." };
    }
    if (action === "add") {
      await client.request<void>("/reactions", {
        method: "POST",
        body: JSON.stringify({
          user_id: userId,
          post_id: params.postId,
          emoji_name: params.emojiName,
        }),
        discardResponse: true,
      });
    } else {
      const emoji = encodeURIComponent(params.emojiName);
      // Mattermost answers with 200 {"status":"OK"}, not 204.
      await client.request<void>(`/users/${userId}/posts/${params.postId}/reactions/${emoji}`, {
        method: "DELETE",
        discardResponse: true,
      });
    }
  } catch (err) {
    return { ok: false, error: `Mattermost ${action} reaction failed: ${String(err)}` };
  }

  return { ok: true };
}
