import { isPrivateNetworkOptInEnabled } from "openclaw/plugin-sdk/ssrf-runtime";
import { resolveMattermostAccount } from "./accounts.js";
import {
  createMattermostClient,
  fetchMattermostMe,
  type MattermostClient,
  type MattermostFetch,
} from "./client.js";
import type { OpenClawConfig } from "./runtime-api.js";

type Result = { ok: true } | { ok: false; error: string };
type ReactionParams = {
  cfg: OpenClawConfig;
  postId: string;
  emojiName: string;
  accountId?: string | null;
  fetchImpl?: MattermostFetch;
};
type ReactionMutation = (client: MattermostClient, params: MutationPayload) => Promise<void>;
type MutationPayload = { userId: string; postId: string; emojiName: string };

const BOT_USER_CACHE_TTL_MS = 10 * 60_000;
const botUserIdCache = new Map<string, { userId: string; expiresAt: number }>();
// Mattermost reaction endpoints use emoji names, not raw unicode.
const UNICODE_TO_MATTERMOST: Record<string, string> = {
  "👀": "eyes",
  "🤔": "thinking_face",
  "🔥": "fire",
  "👨‍💻": "male-technologist",
  "👨💻": "male-technologist",
  "👩‍💻": "female-technologist",
  "⚡": "zap",
  "🌐": "globe_with_meridians",
  "✅": "white_check_mark",
  "👍": "thumbsup",
  "❌": "x",
  "😱": "scream",
  "🥱": "yawning_face",
  "😨": "fearful",
  "⏳": "hourglass_flowing_sand",
  "⚠️": "warning",
  "⚠": "warning",
  "✍️": "writing_hand",
  "✍": "writing_hand",
  "🧠": "brain",
  "🛠️": "hammer_and_wrench",
  "🛠": "hammer_and_wrench",
  "💻": "computer",
};

export function normalizeMattermostReactionEmojiName(emoji: string): string {
  let trimmed = emoji.trim();
  while (trimmed.startsWith(":")) {
    trimmed = trimmed.slice(1);
  }
  while (trimmed.endsWith(":")) {
    trimmed = trimmed.slice(0, -1);
  }
  return UNICODE_TO_MATTERMOST[trimmed] ?? trimmed;
}

async function resolveBotUserId(
  client: MattermostClient,
  cacheKey: string,
): Promise<string | null> {
  const cached = botUserIdCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.userId;
  }
  const me = await fetchMattermostMe(client);
  const userId = me?.id?.trim();
  if (!userId) {
    return null;
  }
  botUserIdCache.set(cacheKey, { userId, expiresAt: Date.now() + BOT_USER_CACHE_TTL_MS });
  return userId;
}

export async function addMattermostReaction(params: {
  cfg: OpenClawConfig;
  postId: string;
  emojiName: string;
  accountId?: string | null;
  fetchImpl?: MattermostFetch;
}): Promise<Result> {
  return runMattermostReaction(params, {
    action: "add",
    mutation: createReaction,
  });
}

export async function removeMattermostReaction(params: {
  cfg: OpenClawConfig;
  postId: string;
  emojiName: string;
  accountId?: string | null;
  fetchImpl?: MattermostFetch;
}): Promise<Result> {
  return runMattermostReaction(params, {
    action: "remove",
    mutation: deleteReaction,
  });
}

export function resetMattermostReactionBotUserCacheForTests(): void {
  botUserIdCache.clear();
}

async function runMattermostReaction(
  params: ReactionParams,
  options: {
    action: "add" | "remove";
    mutation: ReactionMutation;
  },
): Promise<Result> {
  const emojiName = normalizeMattermostReactionEmojiName(params.emojiName);
  if (!emojiName) {
    return { ok: false, error: "Mattermost reaction emoji missing." };
  }
  const resolved = resolveMattermostAccount({ cfg: params.cfg, accountId: params.accountId });
  const baseUrl = resolved.baseUrl?.trim();
  const botToken = resolved.botToken?.trim();
  if (!baseUrl || !botToken) {
    return { ok: false, error: "Mattermost botToken/baseUrl missing." };
  }

  const client = createMattermostClient({
    baseUrl,
    botToken,
    fetchImpl: params.fetchImpl,
    allowPrivateNetwork: isPrivateNetworkOptInEnabled(resolved.config),
  });

  const cacheKey = `${baseUrl}:${botToken}`;
  const userId = await resolveBotUserId(client, cacheKey);
  if (!userId) {
    return { ok: false, error: "Mattermost reactions failed: could not resolve bot user id." };
  }

  try {
    await options.mutation(client, {
      userId,
      postId: params.postId,
      emojiName,
    });
  } catch (err) {
    return { ok: false, error: `Mattermost ${options.action} reaction failed: ${String(err)}` };
  }

  return { ok: true };
}

async function createReaction(client: MattermostClient, params: MutationPayload): Promise<void> {
  await client.request<Record<string, unknown>>("/reactions", {
    method: "POST",
    body: JSON.stringify({
      user_id: params.userId,
      post_id: params.postId,
      emoji_name: params.emojiName,
    }),
  });
}

async function deleteReaction(client: MattermostClient, params: MutationPayload): Promise<void> {
  const emoji = encodeURIComponent(params.emojiName);
  await client.request<unknown>(
    `/users/${params.userId}/posts/${params.postId}/reactions/${emoji}`,
    {
      method: "DELETE",
    },
  );
}
