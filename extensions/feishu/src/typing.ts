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
 * - 99991400: Rate limit (too many requests per second)
 * - 99991403: Monthly API call quota exceeded
 * - 429: Standard HTTP 429 returned as a Feishu SDK error code
 *
 * @see https://open.feishu.cn/document/server-docs/api-call-guide/generic-error-code
 */
const FEISHU_BACKOFF_CODES = new Set([99991400, 99991403, 429]);

/**
 * Custom error class for Feishu backoff conditions detected from non-throwing
 * SDK responses. Carries a numeric `.code` so that `isFeishuBackoffError()`
 * recognises it when the error is caught downstream.
 */
export class FeishuBackoffError extends Error {
  code: number;
  constructor(code: number) {
    super(`Feishu API backoff: code ${code}`);
    this.name = "FeishuBackoffError";
    this.code = code;
  }
}

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
export function getBackoffCodeFromResponse(response: unknown): number | undefined {
  if (typeof response !== "object" || response === null) {
    return undefined;
  }
  const code = (response as { code?: number }).code;
  if (typeof code === "number" && FEISHU_BACKOFF_CODES.has(code)) {
    return code;
  }
  return undefined;
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
    const backoffCode = getBackoffCodeFromResponse(response);
    if (backoffCode !== undefined) {
      console.log(
        `[feishu] typing indicator response contains backoff code ${backoffCode}, stopping keepalive`,
      );
      throw new FeishuBackoffError(backoffCode);
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
    const backoffCode = getBackoffCodeFromResponse(result);
    if (backoffCode !== undefined) {
      console.log(
        `[feishu] typing indicator removal response contains backoff code ${backoffCode}, stopping keepalive`,
      );
      throw new FeishuBackoffError(backoffCode);
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
