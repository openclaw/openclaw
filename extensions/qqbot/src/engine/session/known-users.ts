/** Known user tracking backed by the plugin SQLite state table. */

import type { GatewayPluginRuntime } from "../gateway/types.js";
import { createMemoryKeyedStore, type KeyedStore } from "../state/keyed-store.js";
import type { ChatScope } from "../types.js";
import { formatErrorMessage } from "../utils/format.js";
import { debugLog, debugError } from "../utils/log.js";

/** Persisted record for a user who has interacted with the bot. */
interface KnownUser {
  openid: string;
  type: ChatScope;
  nickname?: string;
  groupOpenid?: string;
  accountId: string;
  firstSeenAt: number;
  lastSeenAt: number;
  interactionCount: number;
}

let usersCache: Map<string, KnownUser> | null = null;
const SAVE_THROTTLE_MS = 5000;
const KNOWN_USERS_NAMESPACE = "known-users";
const MAX_KNOWN_USERS = 100_000;

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let knownUserStore: KeyedStore<KnownUser> = createMemoryKeyedStore();
let dirtyUsers = new Map<string, KnownUser>();

export async function configureKnownUsersStore(runtime: GatewayPluginRuntime): Promise<void> {
  knownUserStore = runtime.state.openKeyedStore<KnownUser>({
    namespace: KNOWN_USERS_NAMESPACE,
    maxEntries: MAX_KNOWN_USERS,
  });
  usersCache = null;
  dirtyUsers = new Map();
  await loadUsersFromStore();
}

function makeUserKey(user: Partial<KnownUser>): string {
  const base = `${user.accountId}:${user.type}:${user.openid}`;
  return user.type === "group" && user.groupOpenid ? `${base}:${user.groupOpenid}` : base;
}

async function loadUsersFromStore(): Promise<Map<string, KnownUser>> {
  if (usersCache !== null) {
    return usersCache;
  }
  usersCache = new Map();
  try {
    const entries = await knownUserStore.entries();
    for (const entry of entries) {
      usersCache.set(makeUserKey(entry.value), entry.value);
    }
    debugLog(`[known-users] Loaded ${usersCache.size} users`);
  } catch (err) {
    debugError(`[known-users] Failed to load users: ${formatErrorMessage(err)}`);
    usersCache = new Map();
  }
  return usersCache;
}

function loadUsersFromStoreSync(): Map<string, KnownUser> {
  if (usersCache === null) {
    usersCache = new Map();
  }
  return usersCache;
}

function saveUsersToStore(): void {
  if (dirtyUsers.size === 0 || saveTimer) {
    return;
  }
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void doSaveUsersToStore();
  }, SAVE_THROTTLE_MS);
}

async function doSaveUsersToStore(): Promise<void> {
  if (dirtyUsers.size === 0) {
    return;
  }
  const pending = dirtyUsers;
  dirtyUsers = new Map();
  try {
    await Promise.all(Array.from(pending, ([key, user]) => knownUserStore.register(key, user)));
  } catch (err) {
    debugError(`[known-users] Failed to save users: ${formatErrorMessage(err)}`);
    for (const [key, user] of pending) {
      dirtyUsers.set(key, user);
    }
  }
}

/** Flush pending writes immediately, typically during shutdown. */
export async function flushKnownUsers(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  await doSaveUsersToStore();
}

/** Record a known user whenever a message is received. */
export function recordKnownUser(user: {
  openid: string;
  type: ChatScope;
  nickname?: string;
  groupOpenid?: string;
  accountId: string;
}): void {
  const cache = loadUsersFromStoreSync();
  const key = makeUserKey(user);
  const now = Date.now();
  const existing = cache.get(key);

  if (existing) {
    existing.lastSeenAt = now;
    existing.interactionCount++;
    if (user.nickname && user.nickname !== existing.nickname) {
      existing.nickname = user.nickname;
    }
  } else {
    cache.set(key, {
      openid: user.openid,
      type: user.type,
      nickname: user.nickname,
      groupOpenid: user.groupOpenid,
      accountId: user.accountId,
      firstSeenAt: now,
      lastSeenAt: now,
      interactionCount: 1,
    });
    debugLog(`[known-users] New user: ${user.openid} (${user.type})`);
  }
  dirtyUsers.set(key, cache.get(key)!);
  saveUsersToStore();
}
