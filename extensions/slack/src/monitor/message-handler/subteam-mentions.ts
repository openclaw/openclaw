import type { WebClient } from "@slack/web-api";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

const SUBTEAM_MENTION_RE = /<!subteam\^([A-Z0-9]+)(?:\|[^>]*)?>/gi;
// Same mention envelope as the inbound owner's SLACK_USER_MENTION_RE in
// message-handler/prepare.ts — ids are matched case-insensitively after
// normalization, so the character class stays permissive.
const USER_MENTION_RE = /<@([^>|]+)(?:\|[^>]*)?>/gi;
const SUBTEAM_MEMBER_CACHE_TTL_MS = 5 * 60 * 1000;

type CacheEntry = {
  expiresAt: number;
  users: ReadonlySet<string>;
};

const subteamMemberCache = new WeakMap<WebClient, Map<string, CacheEntry>>();

export function normalizeSlackId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().toUpperCase() : undefined;
}

/** True when the text carries an explicit `<@USER>` mention of the given user. */
export function slackTextMentionsUser(
  text: string | undefined | null,
  userId?: string | null,
): boolean {
  const target = normalizeSlackId(userId);
  if (!text || !target) {
    return false;
  }
  const mentionRe = new RegExp(USER_MENTION_RE.source, "gi");
  for (const match of text.matchAll(mentionRe)) {
    if (normalizeSlackId(match[1]) === target) {
      return true;
    }
  }
  return false;
}

function extractSlackSubteamMentionIds(text?: string | null): string[] {
  if (!text) {
    return [];
  }
  const ids = new Set<string>();
  for (const match of text.matchAll(SUBTEAM_MENTION_RE)) {
    const id = normalizeSlackId(match[1]);
    if (id) {
      ids.add(id);
    }
  }
  return [...ids];
}

async function readSlackSubteamUsers(params: {
  client: WebClient;
  subteamId: string;
  teamId?: string;
  now: number;
  log?: (message: string) => void;
}): Promise<ReadonlySet<string>> {
  let bySubteam = subteamMemberCache.get(params.client);
  if (!bySubteam) {
    bySubteam = new Map<string, CacheEntry>();
    subteamMemberCache.set(params.client, bySubteam);
  }
  const cacheKey = `${normalizeSlackId(params.teamId) ?? ""}:${params.subteamId}`;
  const cached = bySubteam.get(cacheKey);
  const now = asDateTimestampMs(params.now);
  if (cached) {
    if (
      now !== undefined &&
      asDateTimestampMs(cached.expiresAt) !== undefined &&
      cached.expiresAt > now
    ) {
      return cached.users;
    }
    bySubteam.delete(cacheKey);
  }

  try {
    const response = await params.client.usergroups.users.list({
      usergroup: params.subteamId,
      ...(params.teamId ? { team_id: params.teamId } : {}),
    });
    if (!response.ok) {
      params.log?.(
        `slack: failed to resolve user-group mention ${params.subteamId}: ${response.error ?? "unknown_error"}`,
      );
      return new Set();
    }
    const users = new Set(
      (response.users ?? []).map((userId) => normalizeSlackId(userId)).filter(Boolean) as string[],
    );
    const expiresAt = resolveExpiresAtMsFromDurationMs(SUBTEAM_MEMBER_CACHE_TTL_MS, {
      nowMs: params.now,
    });
    if (expiresAt !== undefined) {
      bySubteam.set(cacheKey, {
        expiresAt,
        users,
      });
    }
    return users;
  } catch (err) {
    params.log?.(
      `slack: failed to resolve user-group mention ${params.subteamId}: ${formatErrorMessage(err)}`,
    );
    return new Set();
  }
}

export async function isSlackSubteamMentionForBot(params: {
  client: WebClient;
  text?: string | null;
  botUserId?: string | null;
  teamId?: string;
  now?: number;
  log?: (message: string) => void;
}): Promise<boolean> {
  const botUserId = normalizeSlackId(params.botUserId);
  if (!botUserId) {
    return false;
  }
  const subteamIds = extractSlackSubteamMentionIds(params.text);
  if (subteamIds.length === 0) {
    return false;
  }
  const now = params.now ?? Date.now();
  for (const subteamId of subteamIds) {
    const users = await readSlackSubteamUsers({
      client: params.client,
      subteamId,
      teamId: normalizeOptionalString(params.teamId),
      now,
      log: params.log,
    });
    if (users.has(botUserId)) {
      return true;
    }
  }
  return false;
}
