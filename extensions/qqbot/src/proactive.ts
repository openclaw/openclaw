/**
 * QQ Bot proactive messaging helpers.
 *
 * This module records known users, sends proactive messages, and lists the
 * stored recipients.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ResolvedQQBotAccount } from "./types.js";
import { debugLog, debugError } from "./utils/debug-log.js";

// Local types.

/** Metadata for a user who has interacted with the bot before. */
export interface KnownUser {
  type: "c2c" | "group" | "channel";
  openid: string;
  accountId: string;
  nickname?: string;
  firstInteractionAt: number;
  lastInteractionAt: number;
}

/** Options for proactive message sending. */
export interface ProactiveSendOptions {
  to: string;
  text: string;
  type?: "c2c" | "group" | "channel";
  imageUrl?: string;
  accountId?: string;
}

/** Result returned from proactive sends. */
export interface ProactiveSendResult {
  success: boolean;
  messageId?: string;
  timestamp?: number | string;
  error?: string;
}

/** Filters for listing known users. */
export interface ListKnownUsersOptions {
  type?: "c2c" | "group" | "channel";
  accountId?: string;
  sortByLastInteraction?: boolean;
  limit?: number;
}
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  getAccessToken,
  sendProactiveC2CMessage,
  sendProactiveGroupMessage,
  sendChannelMessage,
  sendC2CImageMessage,
  sendGroupImageMessage,
} from "./api.js";
import { resolveQQBotAccount } from "./config.js";
// Known-user storage.
import { getQQBotDataDir } from "./utils/platform.js";

const STORAGE_DIR = getQQBotDataDir("data");
const KNOWN_USERS_FILE = path.join(STORAGE_DIR, "known-users.json");

// In-memory cache.
let knownUsersCache: Map<string, KnownUser> | null = null;
let cacheLastModified = 0;

/** Ensure the storage directory exists. */
function ensureStorageDir(): void {
  if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
  }
}

/** Build a stable key for a known user entry. */
function getUserKey(type: string, openid: string, accountId: string): string {
  return `${accountId}:${type}:${openid}`;
}

/** Load known users from disk. */
function loadKnownUsers(): Map<string, KnownUser> {
  if (knownUsersCache !== null) {
    // Reuse the cache when the backing file has not changed.
    try {
      const stat = fs.statSync(KNOWN_USERS_FILE);
      if (stat.mtimeMs <= cacheLastModified) {
        return knownUsersCache;
      }
    } catch {
      // If the file disappeared, keep using the cached state.
      return knownUsersCache;
    }
  }

  const users = new Map<string, KnownUser>();

  try {
    if (fs.existsSync(KNOWN_USERS_FILE)) {
      const data = fs.readFileSync(KNOWN_USERS_FILE, "utf-8");
      const parsed = JSON.parse(data) as KnownUser[];
      for (const user of parsed) {
        const key = getUserKey(user.type, user.openid, user.accountId);
        users.set(key, user);
      }
      cacheLastModified = fs.statSync(KNOWN_USERS_FILE).mtimeMs;
    }
  } catch (err) {
    debugError(`[qqbot:proactive] Failed to load known users: ${err}`);
  }

  knownUsersCache = users;
  return users;
}

/** Persist known users to disk. */
function saveKnownUsers(users: Map<string, KnownUser>): void {
  try {
    ensureStorageDir();
    const data = Array.from(users.values());
    fs.writeFileSync(KNOWN_USERS_FILE, JSON.stringify(data, null, 2), "utf-8");
    cacheLastModified = Date.now();
    knownUsersCache = users;
  } catch (err) {
    debugError(`[qqbot:proactive] Failed to save known users: ${err}`);
  }
}

/**
 * Record a known user when a message is received.
 */
export function recordKnownUser(user: Omit<KnownUser, "firstInteractionAt">): void {
  const users = loadKnownUsers();
  const key = getUserKey(user.type, user.openid, user.accountId);

  const existing = users.get(key);
  const now = user.lastInteractionAt || Date.now();

  users.set(key, {
    ...user,
    lastInteractionAt: now,
    firstInteractionAt: existing?.firstInteractionAt ?? now,
    // Prefer a freshly observed nickname when available.
    nickname: user.nickname || existing?.nickname,
  });

  saveKnownUsers(users);
  debugLog(`[qqbot:proactive] Recorded user: ${key}`);
}

/** Look up a known user entry. */
export function getKnownUser(
  type: string,
  openid: string,
  accountId: string,
): KnownUser | undefined {
  const users = loadKnownUsers();
  const key = getUserKey(type, openid, accountId);
  return users.get(key);
}

/** List known users with optional filtering and sorting. */
export function listKnownUsers(options?: ListKnownUsersOptions): KnownUser[] {
  const users = loadKnownUsers();
  let result = Array.from(users.values());

  // Filter by conversation type.
  if (options?.type) {
    result = result.filter((u) => u.type === options.type);
  }

  // Filter by account.
  if (options?.accountId) {
    result = result.filter((u) => u.accountId === options.accountId);
  }

  // Sort newest-first by default.
  if (options?.sortByLastInteraction !== false) {
    result.sort((a, b) => b.lastInteractionAt - a.lastInteractionAt);
  }

  // Apply the result limit last.
  if (options?.limit && options.limit > 0) {
    result = result.slice(0, options.limit);
  }

  return result;
}

/** Remove one known user entry. */
export function removeKnownUser(type: string, openid: string, accountId: string): boolean {
  const users = loadKnownUsers();
  const key = getUserKey(type, openid, accountId);
  const deleted = users.delete(key);
  if (deleted) {
    saveKnownUsers(users);
  }
  return deleted;
}

/** Clear all known users, optionally scoped to a single account. */
export function clearKnownUsers(accountId?: string): number {
  const users = loadKnownUsers();
  let count = 0;

  if (accountId) {
    for (const [key, user] of users) {
      if (user.accountId === accountId) {
        users.delete(key);
        count++;
      }
    }
  } else {
    count = users.size;
    users.clear();
  }

  if (count > 0) {
    saveKnownUsers(users);
  }
  return count;
}

/** Resolve account config and send a proactive message. */
export async function sendProactive(
  options: ProactiveSendOptions,
  cfg: OpenClawConfig,
): Promise<ProactiveSendResult> {
  const { to, text, type = "c2c", imageUrl, accountId = "default" } = options;

  const account = resolveQQBotAccount(cfg, accountId);

  if (!account.appId || !account.clientSecret) {
    return {
      success: false,
      error: "QQBot not configured (missing appId or clientSecret)",
    };
  }

  try {
    const accessToken = await getAccessToken(account.appId, account.clientSecret);

    if (imageUrl) {
      try {
        if (type === "c2c") {
          await sendC2CImageMessage(account.appId, accessToken, to, imageUrl, undefined, undefined);
        } else if (type === "group") {
          await sendGroupImageMessage(
            account.appId,
            accessToken,
            to,
            imageUrl,
            undefined,
            undefined,
          );
        }
        debugLog(`[qqbot:proactive] Sent image to ${type}:${to}`);
      } catch (err) {
        debugError(`[qqbot:proactive] Failed to send image: ${err}`);
      }
    }

    let result: { id: string; timestamp: number | string };

    if (type === "c2c") {
      result = await sendProactiveC2CMessage(account.appId, accessToken, to, text);
    } else if (type === "group") {
      result = await sendProactiveGroupMessage(account.appId, accessToken, to, text);
    } else if (type === "channel") {
      return {
        success: false,
        error: "Channel proactive messages are not supported. Please use group or c2c.",
      };
    } else {
      return {
        success: false,
        error: `Unknown message type: ${type}`,
      };
    }

    debugLog(`[qqbot:proactive] Sent message to ${type}:${to}, id: ${result.id}`);

    return {
      success: true,
      messageId: result.id,
      timestamp: result.timestamp,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    debugError(`[qqbot:proactive] Failed to send message: ${message}`);

    return {
      success: false,
      error: message,
    };
  }
}

/** Send one proactive message to each recipient. */
export async function sendBulkProactiveMessage(
  recipients: string[],
  text: string,
  type: "c2c" | "group",
  cfg: OpenClawConfig,
  accountId = "default",
): Promise<Array<{ to: string; result: ProactiveSendResult }>> {
  const results: Array<{ to: string; result: ProactiveSendResult }> = [];

  for (const to of recipients) {
    const result = await sendProactive({ to, text, type, accountId }, cfg);
    results.push({ to, result });

    // Add a small delay to reduce rate-limit pressure.
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return results;
}

/**
 * Send a message to all known users.
 *
 * @param text Message content.
 * @param cfg OpenClaw config.
 * @param options Optional filters.
 * @returns Aggregate send statistics.
 */
export async function broadcastMessage(
  text: string,
  cfg: OpenClawConfig,
  options?: {
    type?: "c2c" | "group";
    accountId?: string;
    limit?: number;
  },
): Promise<{
  total: number;
  success: number;
  failed: number;
  results: Array<{ to: string; result: ProactiveSendResult }>;
}> {
  const users = listKnownUsers({
    type: options?.type,
    accountId: options?.accountId,
    limit: options?.limit,
    sortByLastInteraction: true,
  });

  // Channel recipients do not support proactive sends.
  const validUsers = users.filter((u) => u.type === "c2c" || u.type === "group");

  const results: Array<{ to: string; result: ProactiveSendResult }> = [];
  let success = 0;
  let failed = 0;

  for (const user of validUsers) {
    const result = await sendProactive(
      {
        to: user.openid,
        text,
        type: user.type as "c2c" | "group",
        accountId: user.accountId,
      },
      cfg,
    );

    results.push({ to: user.openid, result });

    if (result.success) {
      success++;
    } else {
      failed++;
    }

    // Add a small delay to reduce rate-limit pressure.
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return {
    total: validUsers.length,
    success,
    failed,
    results,
  };
}

// Helpers.

/**
 * Send a proactive message using a resolved account without a full config object.
 *
 * @param account Resolved account configuration.
 * @param to Target openid.
 * @param text Message content.
 * @param type Message type.
 */
export async function sendProactiveMessageDirect(
  account: ResolvedQQBotAccount,
  to: string,
  text: string,
  type: "c2c" | "group" = "c2c",
): Promise<ProactiveSendResult> {
  if (!account.appId || !account.clientSecret) {
    return {
      success: false,
      error: "QQBot not configured (missing appId or clientSecret)",
    };
  }

  try {
    const accessToken = await getAccessToken(account.appId, account.clientSecret);

    let result: { id: string; timestamp: number | string };

    if (type === "c2c") {
      result = await sendProactiveC2CMessage(account.appId, accessToken, to, text);
    } else {
      result = await sendProactiveGroupMessage(account.appId, accessToken, to, text);
    }

    return {
      success: true,
      messageId: result.id,
      timestamp: result.timestamp,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Return known-user counts for the selected account.
 */
export function getKnownUsersStats(accountId?: string): {
  total: number;
  c2c: number;
  group: number;
  channel: number;
} {
  const users = listKnownUsers({ accountId });

  return {
    total: users.length,
    c2c: users.filter((u) => u.type === "c2c").length,
    group: users.filter((u) => u.type === "group").length,
    channel: users.filter((u) => u.type === "channel").length,
  };
}
