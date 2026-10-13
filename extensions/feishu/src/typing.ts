import type { ClawdbotConfig, RuntimeEnv } from "../runtime-api.js";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { getFeishuRuntime } from "./runtime.js";
import {
  FeishuBackoffError,
  getBackoffCodeFromResponse,
  isFeishuBackoffError,
} from "./typing-backoff.js";

// Feishu emoji types for typing indicator
// See: https://open.feishu.cn/document/server-docs/im-v1/message-reaction/emojis-introduce
// Full list: https://github.com/go-lark/lark/blob/main/emoji.go
const TYPING_EMOJI = "Typing";

export type TypingIndicatorState = {
  messageId: string;
  reactionId: string | null;
};

async function requestTypingReaction<T, R>(
  request: () => Promise<T>,
  operation: "add" | "remove",
  readResponse: (response: T) => R,
  runtime?: RuntimeEnv,
): Promise<R | undefined> {
  const indicator = `typing indicator${operation === "remove" ? " removal" : ""}`;
  try {
    const response = await request();
    // SDK errors may be returned rather than thrown; both must trip the breaker.
    const backoffCode = getBackoffCodeFromResponse(response);
    if (backoffCode !== undefined) {
      if (getFeishuRuntime().logging.shouldLogVerbose()) {
        runtime?.log?.(
          `[feishu] ${indicator} response contains backoff code ${backoffCode}, stopping keepalive`,
        );
      }
      throw new FeishuBackoffError(backoffCode);
    }
    return readResponse(response);
  } catch (err) {
    if (isFeishuBackoffError(err)) {
      if (getFeishuRuntime().logging.shouldLogVerbose()) {
        runtime?.log?.(`[feishu] ${indicator} hit rate-limit/quota, stopping keepalive`);
      }
      throw err;
    }
    if (getFeishuRuntime().logging.shouldLogVerbose()) {
      runtime?.log?.(`[feishu] failed to ${operation} typing indicator: ${String(err)}`);
    }
    return undefined;
  }
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
  runtime?: RuntimeEnv;
}): Promise<TypingIndicatorState> {
  const { cfg, messageId, accountId, runtime } = params;
  const account = resolveFeishuRuntimeAccount({ cfg, accountId });
  if (!account.configured) {
    return { messageId, reactionId: null };
  }

  const client = createFeishuClient(account);

  const reactionId = await requestTypingReaction(
    () =>
      client.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: TYPING_EMOJI } },
      }),
    "add",
    (response) => response.data?.reaction_id ?? null,
    runtime,
  );
  return { messageId, reactionId: reactionId ?? null };
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
  runtime?: RuntimeEnv;
}): Promise<void> {
  const { cfg, state, accountId, runtime } = params;
  if (!state.reactionId) {
    return;
  }

  const account = resolveFeishuRuntimeAccount({ cfg, accountId });
  if (!account.configured) {
    return;
  }

  const client = createFeishuClient(account);

  await requestTypingReaction(
    () =>
      client.im.messageReaction.delete({
        path: { message_id: state.messageId, reaction_id: state.reactionId! },
      }),
    "remove",
    () => undefined,
    runtime,
  );
}
