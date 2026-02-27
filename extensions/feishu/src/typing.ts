import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";

// Feishu emoji types for typing indicator
// See: https://open.feishu.cn/document/server-docs/im-v1/message-reaction/emojis-introduce
// Full list: https://github.com/go-lark/lark/blob/main/emoji.go
const TYPING_EMOJI = "Typing"; // Typing indicator emoji

/**
 * Feishu API error codes that indicate the caller should back off.
 * These must propagate to the typing circuit breaker so the keepalive loop
 * can trip and stop retrying.
 *
 * - 99991403: Monthly API call quota exceeded
 * - 99991400: Rate limit (too many requests per second)
 *
 * @see https://open.feishu.cn/document/server-docs/getting-started/server-error-codes
 */
const FEISHU_BACKOFF_CODES = new Set([99991403, 99991400]);

export type TypingIndicatorState = {
  messageId: string;
  reactionId: string | null;
};

/**
 * Check whether an error represents a rate-limit or quota-exceeded condition
 * from the Feishu API that should stop the typing keepalive loop.
 *
 * Handles two shapes:
 * 1. AxiosError with `response.status` and `response.data.code`
 * 2. Feishu SDK error with a top-level `code` property
 */
export function isFeishuBackoffError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) {
    return false;
  }

  // AxiosError shape: err.response.status / err.response.data.code
  const response = (err as { response?: { status?: number; data?: { code?: number } } }).response;
  if (response) {
    if (response.status === 429) {
      return true;
    }
    if (typeof response.data?.code === "number" && FEISHU_BACKOFF_CODES.has(response.data.code)) {
      return true;
    }
  }

  // Feishu SDK error shape: err.code
  const code = (err as { code?: number }).code;
  if (typeof code === "number" && FEISHU_BACKOFF_CODES.has(code)) {
    return true;
  }

  return false;
}

/**
 * Check whether a Feishu SDK response object contains a backoff error code.
 *
 * The Feishu SDK sometimes returns a normal response (no throw) with an
 * API-level error code in the response body. This must be detected so the
 * circuit breaker can trip. See codex review on #28157.
 */
export function hasBackoffCodeInResponse(response: unknown): boolean {
  if (typeof response !== "object" || response === null) {
    return false;
  }
  const code = (response as { code?: number }).code;
  return typeof code === "number" && FEISHU_BACKOFF_CODES.has(code);
}

/**
 * Add a typing indicator (reaction) to a message.
 *
 * Rate-limit and quota errors are re-thrown so the circuit breaker in
 * `createTypingCallbacks` (typing-start-guard) can trip and stop the
 * keepalive loop. See #28062.
 *
 * Also checks for backoff codes in non-throwing SDK responses (#28157).
 */
export async function addTypingIndicator(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  accountId?: string;
}): Promise<TypingIndicatorState> {
  const { cfg, messageId, accountId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured) {
    return { messageId, reactionId: null };
  }

  const client = createFeishuClient(account);

  try {
    const response = await client.im.messageReaction.create({
      path: { message_id: messageId },
      data: {
        reaction_type: { emoji_type: TYPING_EMOJI },
      },
    });

    // Feishu SDK may return a normal response with an API-level error code
    // instead of throwing. Detect backoff codes and throw to trip the breaker.
    if (hasBackoffCodeInResponse(response)) {
      const code = (response as { code?: number }).code;
      console.log(`[feishu] typing indicator response contains backoff code ${code}, stopping keepalive`);
      throw new Error(`Feishu API backoff: code ${code}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK response type
    const reactionId = (response as any)?.data?.reaction_id ?? null;
    return { messageId, reactionId };
  } catch (err) {
    if (isFeishuBackoffError(err)) {
      console.log(`[feishu] typing indicator hit rate-limit/quota, stopping keepalive`);
      throw err;
    }
    // Silently fail for other non-critical errors (e.g. message deleted, permission issues)
    console.log(`[feishu] failed to add typing indicator: ${err}`);
    return { messageId, reactionId: null };
  }
}

/**
 * Remove a typing indicator (reaction) from a message.
 *
 * Rate-limit and quota errors are re-thrown for the same reason as above.
 */
export async function removeTypingIndicator(params: {
  cfg: ClawdbotConfig;
  state: TypingIndicatorState;
  accountId?: string;
}): Promise<void> {
  const { cfg, state, accountId } = params;
  if (!state.reactionId) {
    return;
  }

  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured) {
    return;
  }

  const client = createFeishuClient(account);

  try {
    const result = await client.im.messageReaction.delete({
      path: {
        message_id: state.messageId,
        reaction_id: state.reactionId,
      },
    });

    // Check for backoff codes in non-throwing SDK responses
    if (hasBackoffCodeInResponse(result)) {
      const code = (result as { code?: number }).code;
      console.log(`[feishu] typing indicator removal response contains backoff code ${code}, stopping keepalive`);
      throw new Error(`Feishu API backoff: code ${code}`);
    }
  } catch (err) {
    if (isFeishuBackoffError(err)) {
      console.log(`[feishu] typing indicator removal hit rate-limit/quota, stopping keepalive`);
      throw err;
    }
    // Silently fail for other non-critical errors
    console.log(`[feishu] failed to remove typing indicator: ${err}`);
  }
}
