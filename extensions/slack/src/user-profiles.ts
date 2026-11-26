import type { WebClient } from "@slack/web-api";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createSlackTokenCacheKey } from "./client.js";
import { readLruMapEntry, writeLruMapEntry } from "./monitor/lru-map-cache.js";

export type SlackUserProfile = {
  displayName?: string;
  realName?: string;
  handle?: string;
  imageUrl?: string;
};

export type SlackMessageUserProfile = {
  display_name?: string;
  real_name?: string;
  name?: string;
};

const SLACK_USER_PROFILE_CACHE_MAX_ENTRIES = 2048;
// One bounded cache per account, shared by the monitor and message reads.
const profileCaches = new Map<string, Map<string, SlackUserProfile>>();

function accountCache(accountId: string): Map<string, SlackUserProfile> {
  let cache = profileCaches.get(accountId);
  if (!cache) {
    cache = new Map();
    profileCaches.set(accountId, cache);
  }
  return cache;
}

type SlackUserProfileScope = { accountId: string; teamId?: string; token?: string };

// A token belongs to one workspace, so the token and team together name the directory answering.
const cacheKey = (scope: SlackUserProfileScope, userId: string) =>
  `${scope.token ? createSlackTokenCacheKey(scope.token) : "client"}\0${scope.teamId ?? ""}\0${userId}`;

/** Starts an empty cache for the account, so a monitor start reads current names. */
export function resetSlackUserProfileCache(accountId: string): void {
  profileCaches.set(accountId, new Map());
}

export function readCachedSlackUserProfile(
  scope: SlackUserProfileScope,
  userId: string,
): SlackUserProfile | undefined {
  return readLruMapEntry(accountCache(scope.accountId), cacheKey(scope, userId));
}

/** Returns the cached profile or calls users.info; failures throw and are not cached. */
export async function resolveSlackUserProfile(
  params: SlackUserProfileScope & { userId: string; client: WebClient },
): Promise<SlackUserProfile> {
  const cached = readCachedSlackUserProfile(params, params.userId);
  if (cached) {
    return cached;
  }
  const { user } = await params.client.users.info({
    ...(params.token ? { token: params.token } : {}),
    user: params.userId,
  });
  const profile = user?.profile;
  const entry: SlackUserProfile = {
    displayName: normalizeOptionalString(profile?.display_name),
    realName: normalizeOptionalString(profile?.real_name),
    handle: normalizeOptionalString(user?.name),
    imageUrl:
      normalizeOptionalString(profile?.image_192) ??
      normalizeOptionalString(profile?.image_512) ??
      normalizeOptionalString(profile?.image_72),
  };
  writeLruMapEntry(
    accountCache(params.accountId),
    cacheKey(params, params.userId),
    entry,
    SLACK_USER_PROFILE_CACHE_MAX_ENTRIES,
  );
  return entry;
}

// Slack writes a user mention as <@U…> or <@U…|label> in text and as a "user" element in blocks.
const MENTION_PATTERN = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;

function blockMentions(node: unknown, ids: Set<string>) {
  if (Array.isArray(node)) {
    node.forEach((child) => blockMentions(child, ids));
  } else if (isRecord(node)) {
    if (node.type === "user" && typeof node.user_id === "string") {
      ids.add(node.user_id);
    }
    Object.values(node).forEach((child) => blockMentions(child, ids));
  }
}

/** The users a message mentions, from its text and blocks. */
function mentionedUsers(message: { text?: string; blocks?: unknown[] }) {
  const ids = new Set<string>();
  for (const match of message.text?.matchAll(MENTION_PATTERN) ?? []) {
    ids.add(match[1]!);
  }
  blockMentions(message.blocks, ids);
  return ids;
}

/**
 * Adds `user_profile` names to messages and answers the names of the users they mention, by
 * user ID. Each uncached author or mentioned user is looked up once, in parallel; one whose lookup
 * fails keeps only its ID.
 */
export async function addSlackUserProfiles<
  T extends {
    user?: string;
    user_profile?: SlackMessageUserProfile;
    text?: string;
    blocks?: unknown[];
  },
>(
  params: SlackUserProfileScope & { client: WebClient; messages: T[] },
): Promise<{ messages: T[]; mentioned: Record<string, SlackMessageUserProfile> }> {
  const authors = params.messages.flatMap((message) =>
    message.user && !message.user_profile ? [message.user] : [],
  );
  const mentions = new Set(params.messages.flatMap((message) => [...mentionedUsers(message)]));
  const profiles = new Map(
    await Promise.all(
      [...new Set([...authors, ...mentions])].map(async (userId) => {
        try {
          const { displayName, realName, handle } = await resolveSlackUserProfile({
            ...params,
            userId,
          });
          const named = displayName || realName || handle;
          const profile = { display_name: displayName, real_name: realName, name: handle };
          return [userId, named ? profile : undefined] as const;
        } catch (error) {
          logVerbose(`slack read: users.info failed for ${userId}: ${String(error)}`);
          return [userId, undefined] as const;
        }
      }),
    ),
  );
  const mentioned: Record<string, SlackMessageUserProfile> = {};
  for (const userId of mentions) {
    const profile = profiles.get(userId);
    if (profile) {
      mentioned[userId] = profile;
    }
  }
  return {
    messages: params.messages.map((message) => {
      const profile =
        message.user && !message.user_profile ? profiles.get(message.user) : undefined;
      return profile ? { ...message, user_profile: profile } : message;
    }),
    mentioned,
  };
}
