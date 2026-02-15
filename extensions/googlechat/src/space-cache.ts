import type { MoltbotConfig } from "clawdbot/plugin-sdk";
import { DEFAULT_ACCOUNT_ID } from "clawdbot/plugin-sdk";

import type { GoogleChatKnownSpace, GoogleChatKnownSpaces } from "../../../config/types.googlechat.js";
import type { GoogleChatConfig } from "./types.config.js";

export type SpaceCacheEntry = {
  userId: string;
  spaceId: string;
  displayName?: string;
  type?: "DM" | "ROOM";
};

/**
 * Extract user ID from a Google Chat user resource name.
 * e.g., "users/123456" -> "users/123456"
 * e.g., "123456" -> "users/123456"
 */
function normalizeUserId(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("users/")) return trimmed;
  return `users/${trimmed}`;
}

/**
 * Get the knownSpaces map for a specific account.
 */
export function getKnownSpaces(
  cfg: MoltbotConfig,
  accountId: string = DEFAULT_ACCOUNT_ID,
): GoogleChatKnownSpaces {
  const channel = cfg.channels?.["googlechat"] as GoogleChatConfig | undefined;
  if (!channel) return {};
  
  const accountConfig = accountId === DEFAULT_ACCOUNT_ID 
    ? channel 
    : channel.accounts?.[accountId];
    
  return accountConfig?.knownSpaces ?? {};
}

/**
 * Look up a cached space ID for a user.
 * Returns undefined if not found.
 */
export function getCachedSpaceForUser(
  cfg: MoltbotConfig,
  userId: string,
  accountId: string = DEFAULT_ACCOUNT_ID,
): GoogleChatKnownSpace | undefined {
  const knownSpaces = getKnownSpaces(cfg, accountId);
  const normalizedUserId = normalizeUserId(userId);
  return knownSpaces[normalizedUserId];
}

/**
 * Check if we have a cached space for a user.
 */
export function hasCachedSpace(
  cfg: MoltbotConfig,
  userId: string,
  accountId: string = DEFAULT_ACCOUNT_ID,
): boolean {
  return getCachedSpaceForUser(cfg, userId, accountId) !== undefined;
}

/**
 * Build config patch to cache a space mapping.
 * Returns the patch object to merge into config.
 */
export function buildSpaceCachePatch(
  entry: SpaceCacheEntry,
  accountId: string = DEFAULT_ACCOUNT_ID,
): Partial<MoltbotConfig> {
  const normalizedUserId = normalizeUserId(entry.userId);
  const spaceEntry: GoogleChatKnownSpace = {
    spaceId: entry.spaceId,
    displayName: entry.displayName,
    type: entry.type,
    lastSeenAt: Date.now(),
  };

  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      channels: {
        googlechat: {
          knownSpaces: {
            [normalizedUserId]: spaceEntry,
          },
        },
      },
    };
  }

  return {
    channels: {
      googlechat: {
        accounts: {
          [accountId]: {
            knownSpaces: {
              [normalizedUserId]: spaceEntry,
            },
          },
        },
      },
    },
  };
}

/**
 * Extract space info from an incoming Google Chat event.
 */
export function extractSpaceInfoFromEvent(event: {
  space?: { name?: string; displayName?: string; type?: string };
  user?: { name?: string };
}): SpaceCacheEntry | null {
  const spaceId = event.space?.name;
  const userId = event.user?.name;
  
  if (!spaceId || !userId) return null;
  
  const spaceType = event.space?.type?.toUpperCase() === "DM" ? "DM" : "ROOM";
  
  return {
    userId,
    spaceId,
    displayName: event.space?.displayName,
    type: spaceType,
  };
}
