import type { MoltbotConfig } from "clawdbot/plugin-sdk";

import type { ResolvedGoogleChatAccount } from "./accounts.js";
import { findGoogleChatDirectMessage } from "./api.js";
import { getCachedSpaceForUser } from "./space-cache.js";

export function normalizeGoogleChatTarget(raw?: string | null): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  const withoutPrefix = trimmed.replace(/^(googlechat|google-chat|gchat):/i, "");
  const normalized = withoutPrefix
    .replace(/^user:(users\/)?/i, "users/")
    .replace(/^space:(spaces\/)?/i, "spaces/");
  if (isGoogleChatUserTarget(normalized)) {
    const suffix = normalized.slice("users/".length);
    return suffix.includes("@") ? `users/${suffix.toLowerCase()}` : normalized;
  }
  if (isGoogleChatSpaceTarget(normalized)) {
    return normalized;
  }
  if (normalized.includes("@")) {
    return `users/${normalized.toLowerCase()}`;
  }
  return normalized;
}

export function isGoogleChatUserTarget(value: string): boolean {
  return value.toLowerCase().startsWith("users/");
}

export function isGoogleChatSpaceTarget(value: string): boolean {
  return value.toLowerCase().startsWith("spaces/");
}

function stripMessageSuffix(target: string): string {
  const index = target.indexOf("/messages/");
  if (index === -1) {
    return target;
  }
  return target.slice(0, index);
}

export type ResolveSpaceOptions = {
  /** Enable cached space lookup (default: true) */
  useCache?: boolean;
  /** Enable findDirectMessage API fallback (default: true) */
  useFindDirectMessage?: boolean;
};

/**
 * Resolve a Google Chat target to a space ID.
 * 
 * Resolution order:
 * 1. If target is already a space ID, return it
 * 2. Check knownSpaces cache for user
 * 3. Call findDirectMessage API (if enabled)
 * 4. Throw error if no space found
 */
export async function resolveGoogleChatOutboundSpace(
  params: {
    account: ResolvedGoogleChatAccount;
    target: string;
    cfg?: MoltbotConfig;
  } & ResolveSpaceOptions,
): Promise<string> {
  const { account, target, cfg, useCache = true, useFindDirectMessage = true } = params;
  
  const normalized = normalizeGoogleChatTarget(target);
  if (!normalized) {
    throw new Error("Missing Google Chat target.");
  }
  
  const base = stripMessageSuffix(normalized);

  // 1. Already a space target
  if (isGoogleChatSpaceTarget(base)) {
    return base;
  }

  // 2. User target - try cache first
  if (isGoogleChatUserTarget(base) && useCache && cfg) {
    const cached = getCachedSpaceForUser(cfg, base, account.accountId);
    if (cached?.spaceId) {
      return cached.spaceId;
    }
  }

  // 3. User target - try findDirectMessage API
  if (isGoogleChatUserTarget(base) && useFindDirectMessage) {
    const dm = await findGoogleChatDirectMessage({
      account,
      userName: base,
    });
    if (dm?.name) {
      return dm.name;
    }
  }

  // 4. Failed to resolve
  if (isGoogleChatUserTarget(base)) {
    throw new Error(
      `No Google Chat DM found for ${base}. ` +
        `The user must message the bot first, or you can use: ` +
        `moltbot message send --channel googlechat --to "spaces/XXX" --text "..."`,
    );
  }

  return base;
}
