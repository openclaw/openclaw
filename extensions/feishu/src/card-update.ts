import type { FeishuCardInteractionEnvelope } from "./card-interaction.js";

export type PendingCardUpdate = {
  accountId: string;
  messageId: string;
  chatId: string;
  originalEnvelope: FeishuCardInteractionEnvelope;
  registeredAt: number;
};

const FEISHU_CARD_UPDATE_TTL_MS = 15 * 60 * 1000; // 15 minutes

const pendingUpdates = new Map<string, PendingCardUpdate>();

function generateUpdateId(): string {
  return `cu_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

function pruneExpiredEntries(now: number): void {
  for (const [id, entry] of pendingUpdates.entries()) {
    if (entry.registeredAt + FEISHU_CARD_UPDATE_TTL_MS < now) {
      pendingUpdates.delete(id);
    }
  }
}

/**
 * Register a new pending card update.
 * Returns the update ID that can be used to later update the card.
 */
export function registerPendingCardUpdate(
  params: Omit<PendingCardUpdate, "registeredAt">,
  now?: number,
): string {
  const currentTime = now ?? Date.now();
  pruneExpiredEntries(currentTime);

  const id = generateUpdateId();
  pendingUpdates.set(id, {
    ...params,
    registeredAt: currentTime,
  });

  return id;
}

/**
 * Get a pending card update by ID.
 * Returns null if not found or expired.
 */
export function getPendingCardUpdate(id: string, now?: number): PendingCardUpdate | null {
  const currentTime = now ?? Date.now();
  pruneExpiredEntries(currentTime);

  const entry = pendingUpdates.get(id);
  if (!entry) {
    return null;
  }

  if (entry.registeredAt + FEISHU_CARD_UPDATE_TTL_MS < currentTime) {
    pendingUpdates.delete(id);
    return null;
  }

  return entry;
}

/**
 * Mark a card update as completed (removes from registry).
 */
export function completeCardUpdate(id: string): void {
  pendingUpdates.delete(id);
}

/**
 * Reset registry for tests.
 */
export function resetCardUpdateRegistryForTests(): void {
  pendingUpdates.clear();
}
