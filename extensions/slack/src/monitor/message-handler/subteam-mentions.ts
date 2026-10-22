import type { WebClient } from "@slack/web-api";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { getOrCreateWeakOwnerMap } from "../lru-map-cache.js";

const SUBTEAM_MENTION_RE = /<!subteam\^([A-Z0-9]+)(?:\|[^>]*)?>/gi;
const SUBTEAM_MEMBER_CACHE_TTL_MS = 5 * 60 * 1000;

type CacheEntry = {
  expiresAt: number;
  users: ReadonlySet<string>;
};

const subteamMemberCache = new WeakMap<WebClient, Map<string, CacheEntry>>();

export function normalizeSlackId(value: unknown): string | undefined {
  return normalizeOptionalString(value)?.toUpperCase();
}

export function collectSlackMentionIds(text: string | null | undefined, regex: RegExp): string[] {
  const ids = new Set<string>();
  regex.lastIndex = 0;
  for (const match of (text ?? "").matchAll(regex)) {
    const id = normalizeSlackId(match[1]);
    if (id) {
      ids.add(id);
    }
  }
  return [...ids];
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
  const subteamIds = collectSlackMentionIds(params.text, SUBTEAM_MENTION_RE);
  if (subteamIds.length === 0) {
    return false;
  }
  const now = params.now ?? Date.now();
  for (const subteamId of subteamIds) {
    const { client, log } = params;
    const teamId = normalizeOptionalString(params.teamId);
    const bySubteam = getOrCreateWeakOwnerMap(subteamMemberCache, client);
    const cacheKey = `${normalizeSlackId(teamId) ?? ""}:${subteamId}`;
    const cached = bySubteam.get(cacheKey);
    if (cached) {
      if (cached.expiresAt > now) {
        if (cached.users.has(botUserId)) {
          return true;
        }
        continue;
      }
      bySubteam.delete(cacheKey);
    }

    let users: ReadonlySet<string>;
    try {
      const response = await client.usergroups.users.list({
        usergroup: subteamId,
        ...(teamId ? { team_id: teamId } : {}),
      });
      if (!response.ok) {
        log?.(
          `slack: failed to resolve user-group mention ${subteamId}: ${response.error ?? "unknown_error"}`,
        );
        continue;
      }
      users = new Set(
        (response.users ?? []).map(normalizeSlackId).filter((userId) => userId !== undefined),
      );
      bySubteam.set(cacheKey, {
        expiresAt: now + SUBTEAM_MEMBER_CACHE_TTL_MS,
        users,
      });
    } catch (err) {
      log?.(`slack: failed to resolve user-group mention ${subteamId}: ${formatErrorMessage(err)}`);
      continue;
    }
    if (users.has(botUserId)) {
      return true;
    }
  }
  return false;
}
