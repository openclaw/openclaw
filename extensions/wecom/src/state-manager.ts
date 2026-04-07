/**
 * WeCom global state management module
 *
 * Manages WSClient instances, message state (with TTL cleanup), and ReqId storage.
 * Solves memory leak issues with global Maps.
 */

import type { WSClient } from "@wecom/aibot-node-sdk";
import {
  MESSAGE_STATE_TTL_MS,
  MESSAGE_STATE_CLEANUP_INTERVAL_MS,
  MESSAGE_STATE_MAX_SIZE,
} from "./const.js";
import type { MessageState } from "./interface.js";
import { createPersistentReqIdStore, type PersistentReqIdStore } from "./reqid-store.js";

// ============================================================================
// WSClient instance management
// ============================================================================

/** WSClient instance management */
const wsClientInstances = new Map<string, WSClient>();

/**
 * Get the WSClient instance for a specified account
 */
export function getWeComWebSocket(accountId: string): WSClient | null {
  return wsClientInstances.get(accountId) ?? null;
}

/**
 * Set the WSClient instance for a specified account
 */
export function setWeComWebSocket(accountId: string, client: WSClient): void {
  wsClientInstances.set(accountId, client);
}

/**
 * Delete the WSClient instance for a specified account
 */
export function deleteWeComWebSocket(accountId: string): void {
  wsClientInstances.delete(accountId);
}

// ============================================================================
// Message state management (with TTL cleanup to prevent memory leaks)
// ============================================================================

/** Message state entry (with creation timestamp for TTL cleanup) */
interface MessageStateEntry {
  state: MessageState;
  createdAt: number;
}

/** Message state management */
const messageStates = new Map<string, MessageStateEntry>();

/** Periodic cleanup timer */
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

/** Reference count of active accounts relying on the cleanup timer */
let cleanupRefCount = 0;

/**
 * Start periodic message state cleanup (automatic TTL cleanup + capacity limit)
 *
 * Uses reference counting so that the timer is only created on the first call
 * and only destroyed when the last account calls stopMessageStateCleanup().
 */
export function startMessageStateCleanup(): void {
  cleanupRefCount++;

  if (cleanupTimer) {
    return;
  }

  cleanupTimer = setInterval(() => {
    pruneMessageStates();
  }, MESSAGE_STATE_CLEANUP_INTERVAL_MS);

  // Allow process exit without blocking
  if (cleanupTimer && typeof cleanupTimer === "object" && "unref" in cleanupTimer) {
    cleanupTimer.unref();
  }
}

/**
 * Stop periodic message state cleanup
 *
 * Decrements the reference count. The timer is only destroyed when the count
 * reaches zero (i.e., no active accounts remain).
 */
export function stopMessageStateCleanup(): void {
  if (cleanupRefCount > 0) {
    cleanupRefCount--;
  }

  if (cleanupRefCount === 0 && cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

/**
 * Clean up expired and over-capacity message state entries
 */
function pruneMessageStates(): void {
  const now = Date.now();

  // 1. Clean up expired entries
  for (const [key, entry] of messageStates) {
    if (now - entry.createdAt >= MESSAGE_STATE_TTL_MS) {
      messageStates.delete(key);
    }
  }

  // 2. Capacity limit: if still exceeding max entries, evict the oldest by time
  if (messageStates.size > MESSAGE_STATE_MAX_SIZE) {
    const sorted = [...messageStates.entries()].toSorted((a, b) => a[1].createdAt - b[1].createdAt);
    const toRemove = sorted.slice(0, messageStates.size - MESSAGE_STATE_MAX_SIZE);
    for (const [key] of toRemove) {
      messageStates.delete(key);
    }
  }
}

/**
 * Set message state
 */
export function setMessageState(messageId: string, state: MessageState): void {
  messageStates.set(messageId, {
    state,
    createdAt: Date.now(),
  });
}

/**
 * Get message state
 */
export function getMessageState(messageId: string): MessageState | undefined {
  const entry = messageStates.get(messageId);
  if (!entry) {
    return undefined;
  }

  // Check TTL
  if (Date.now() - entry.createdAt >= MESSAGE_STATE_TTL_MS) {
    messageStates.delete(messageId);
    return undefined;
  }
  return entry.state;
}

/**
 * Delete message state
 */
export function deleteMessageState(messageId: string): void {
  messageStates.delete(messageId);
}

/**
 * Clear all message states
 */
export function clearAllMessageStates(): void {
  messageStates.clear();
}

// ============================================================================
// ReqId persistent storage management (isolated by accountId)
// ============================================================================

/**
 * ReqId persistent storage management
 * Based on the createPersistentDedupe pattern: memory + disk dual layer, file lock, atomic write, TTL expiry, debounced write.
 * Can recover from disk after restart, ensuring reqId is available for proactive message sending.
 */
const reqIdStores = new Map<string, PersistentReqIdStore>();

function getOrCreateReqIdStore(accountId: string): PersistentReqIdStore {
  let store = reqIdStores.get(accountId);
  if (!store) {
    store = createPersistentReqIdStore(accountId);
    reqIdStores.set(accountId, store);
  }
  return store;
}

// ============================================================================
// ReqId helper functions
// ============================================================================

/**
 * Set the reqId for a chatId (write to memory + debounce disk writes)
 */
export function setReqIdForChat(chatId: string, reqId: string, accountId = "default"): void {
  getOrCreateReqIdStore(accountId).set(chatId, reqId);
}

/**
 * Get the reqId for a chatId (async: prefer memory, fall back to disk on miss and repopulate memory)
 */
export async function getReqIdForChatAsync(
  chatId: string,
  accountId = "default",
): Promise<string | undefined> {
  return getOrCreateReqIdStore(accountId).get(chatId);
}

/**
 * Get the reqId for a chatId (sync: memory only, kept for backward compatibility)
 */
export function getReqIdForChat(chatId: string, accountId = "default"): string | undefined {
  return getOrCreateReqIdStore(accountId).getSync(chatId);
}

/**
 * Delete the reqId for a chatId
 */
export function deleteReqIdForChat(chatId: string, accountId = "default"): void {
  getOrCreateReqIdStore(accountId).delete(chatId);
}

/**
 * Warm up the reqId cache at startup (load from disk into memory)
 *
 * Note: because disk storage was removed, this function now only returns 0 (no warmed entries)
 */
export async function warmupReqIdStore(
  accountId = "default",
  log?: (...args: unknown[]) => void,
): Promise<number> {
  // Since disk storage was removed, a warmup process is no longer needed
  log?.("[WeCom] reqid-store warmup: no-op (disk storage removed)");
  return 0;
}

/**
 * Immediately flush reqId data to disk (for graceful shutdown)
 *
 * Note: Since disk storage has been removed, this function is a no-op
 */
export async function flushReqIdStore(_accountId = "default"): Promise<void> {
  // Since disk storage has been removed, no flush operation is needed
}

// ============================================================================
// Global cleanup (release all resources when disconnecting)
// ============================================================================

/**
 * Clean up all resources for the specified account
 */
export async function cleanupAccount(accountId: string): Promise<void> {
  // 1. Disconnect WSClient
  const wsClient = wsClientInstances.get(accountId);
  if (wsClient) {
    try {
      wsClient.disconnect();
    } catch {
      // Ignore errors while disconnecting
    }
    wsClientInstances.delete(accountId);
  }

  // 2. Since disk storage has been removed, no need to flush reqId storage
  // Note: do not delete the store, as it may still be needed after reconnection
}

/**
 * Clean up all resources (for process exit)
 */
export async function cleanupAll(): Promise<void> {
  // Force-stop periodic cleanup regardless of ref count
  cleanupRefCount = 0;
  stopMessageStateCleanup();

  // Clean up all WSClient instances
  for (const [_accountId, wsClient] of wsClientInstances) {
    try {
      wsClient.disconnect();
    } catch {
      // Ignore
    }
  }
  wsClientInstances.clear();

  // Since disk storage has been removed, no need to flush all reqId stores

  // Clear all message states
  clearAllMessageStates();
}
