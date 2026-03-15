/**
 * Telegram Send Dedup Integration Adapter
 *
 * Provides wrapper functions that integrate SendDedup into existing
 * Telegram send operations with minimal code changes.
 *
 * Usage:
 * ```ts
 * // Replace direct api.sendMessage calls with wrapped version
 * const result = await sendMessageWithDedup({
 *   chatId,
 *   text,
 *   api,
 *   send: (params) => api.sendMessage(chatId, text, params),
 * });
 * ```
 */

import { getGlobalSendDedup } from "./send-dedup.js";

/**
 * Options for wrapped send operations.
 */
export interface SendDedupWrapperOptions {
  /**
   * Target chat ID.
   */
  chatId: string;

  /**
   * Primary send parameters for dedup hashing.
   * Include: text, buttons, media, caption, etc.
   */
  dedupParams: Record<string, unknown>;

  /**
   * Function that performs the actual send.
   * Called only if dedup check passes.
   *
   * @param effectiveParams Parameters to pass to the send function
   * @returns The Telegram API response with message_id
   */
  send: (effectiveParams?: Record<string, unknown>) => Promise<{ message_id: number; chat?: { id?: string | number } }>;

  /**
   * Optional callback for dedup hit (duplicate detected).
   * Receives metadata about the cached send.
   */
  onDedupHit?: (metadata: {
    contentHash: string;
    attemptCount: number;
    firstAttemptMs: number;
    messageId?: number;
  }) => void;

  /**
   * Optional callback for dedup miss (new send).
   * Useful for logging.
   */
  onDedupMiss?: (contentHash: string) => void;

  /**
   * Optional callback for send failure.
   * Dedup entry remains in cache for potential retry.
   */
  onSendFailure?: (error: unknown, metadata: { contentHash: string; attemptCount: number }) => void;

  /**
   * Optional logging function.
   */
  log?: (message: string) => void;
}

/**
 * Wraps a Telegram send operation with automatic deduplication.
 *
 * Returns the message ID from either:
 * 1. A cached successful send (if duplicate detected)
 * 2. A new send to Telegram API (if no recent duplicate)
 *
 * @param options Wrapper configuration
 * @returns Message ID of sent message
 * @throws If send fails and no cached result exists
 *
 * @example
 * ```ts
 * const messageId = await sendMessageWithDedup({
 *   chatId: "123456",
 *   dedupParams: { text: "Hello", buttons: [...] },
 *   send: (params) => api.sendMessage(chatId, text, params),
 * });
 * ```
 */
export async function sendMessageWithDedup(
  options: SendDedupWrapperOptions,
): Promise<number> {
  const { chatId, dedupParams, send, onDedupHit, onDedupMiss, onSendFailure, log } = options;

  const dedup = getGlobalSendDedup();
  const contentHash = dedup.hashSendParams(chatId, dedupParams);

  // Check for recent identical send
  if (dedup.hasPendingOrSuccessful(contentHash)) {
    const metadata = dedup.getMetadata(contentHash);
    log?.(`telegram: dedup hit for chat ${chatId} (attempts: ${metadata?.attemptCount ?? 0})`);

    onDedupHit?.(
      metadata
        ? {
            contentHash,
            attemptCount: metadata.attemptCount,
            firstAttemptMs: metadata.firstAttemptMs,
            messageId: metadata.messageId,
          }
        : {
            contentHash,
            attemptCount: 0,
            firstAttemptMs: Date.now(),
          },
    );

    // If we have a cached message ID, return it
    if (metadata?.messageId) {
      return metadata.messageId;
    }

    // If we don't have a cached result yet, the send is still pending/failed
    // In this case, we should throw to avoid returning undefined
    throw new Error(`telegram dedup: pending send has no cached message ID (chat: ${chatId})`);
  }

  // Record attempt and proceed with send
  dedup.recordAttempt(contentHash, chatId);
  onDedupMiss?.(contentHash);
  log?.(`telegram: new send to chat ${chatId}`);

  try {
    const response = await send();
    const messageId = response.message_id ?? response.message_id;

    if (!Number.isFinite(messageId)) {
      throw new Error("telegram send response missing message_id");
    }

    // Record success
    dedup.recordSuccess(contentHash, messageId);
    log?.(`telegram: send success (message_id: ${messageId})`);

    return messageId;
  } catch (error) {
    const metadata = dedup.recordFailure(contentHash);
    onSendFailure?.(error, {
      contentHash,
      attemptCount: metadata?.attemptCount ?? 1,
    });
    log?.(`telegram: send failed (will retry with same dedup entry)`);
    throw error;
  }
}

/**
 * Create a dedup-enabled send function from a base send operation.
 *
 * Useful for wrapping existing send functions with consistent dedup behavior.
 *
 * @param baseSend The underlying send function
 * @param options Configuration (without send function)
 * @returns A dedup-enabled version
 *
 * @example
 * ```ts
 * const sendWithDedup = createDedupSendFunction(
 *   (params) => api.sendMessage(chatId, text, params),
 *   { chatId, dedupParams: { text }, log }
 * );
 *
 * const messageId = await sendWithDedup();
 * ```
 */
export function createDedupSendFunction(
  baseSend: (
    params?: Record<string, unknown>,
  ) => Promise<{ message_id: number; chat?: { id?: string | number } }>,
  options: Omit<SendDedupWrapperOptions, "send">,
): () => Promise<number> {
  return () =>
    sendMessageWithDedup({
      ...options,
      send: baseSend,
    });
}

/**
 * Batch dedup check for multiple sends in sequence.
 *
 * Useful when sending multiple related messages and wanting to detect
 * if any of them are duplicates.
 *
 * @param chatId Target chat
 * @param messages List of messages with dedup params
 * @returns Result for each message (either cached or new)
 *
 * @example
 * ```ts
 * const results = await checkBatchSendDedup(chatId, [
 *   { dedupParams: { text: "Message 1" }, send: () => ... },
 *   { dedupParams: { text: "Message 2" }, send: () => ... },
 * ]);
 * ```
 */
export async function checkBatchSendDedup(
  chatId: string,
  messages: Array<{
    dedupParams: Record<string, unknown>;
    send: () => Promise<{ message_id: number; chat?: { id?: string | number } }>;
  }>,
): Promise<Array<{ messageId: number; isDuplicate: boolean }>> {
  const results: Array<{ messageId: number; isDuplicate: boolean }> = [];

  for (const message of messages) {
    try {
      const messageId = await sendMessageWithDedup({
        chatId,
        dedupParams: message.dedupParams,
        send: message.send,
      });
      results.push({ messageId, isDuplicate: false });
    } catch (error) {
      // For batch operations, we might want to collect errors instead of throwing
      // This allows partial success scenarios
      throw error;
    }
  }

  return results;
}

/**
 * Manually clear a dedup entry (force retry on next send).
 *
 * Use cautiously - clearing an entry might allow duplicate sends if
 * the original message is still being processed.
 *
 * @param chatId Target chat
 * @param dedupParams Send parameters
 */
export function clearDedupEntry(chatId: string, dedupParams: Record<string, unknown>): void {
  const dedup = getGlobalSendDedup();
  const hash = dedup.hashSendParams(chatId, dedupParams);
  dedup.clear(hash);
}

/**
 * Get dedup cache statistics for monitoring.
 *
 * Useful for observability and debugging.
 *
 * @returns Cache statistics
 */
export function getDedupStats(): {
  cacheSize: number;
  maxSize: number;
} {
  const dedup = getGlobalSendDedup();
  return {
    cacheSize: dedup.size(),
    maxSize: 1000, // This should ideally be exposed from SendDedup
  };
}
