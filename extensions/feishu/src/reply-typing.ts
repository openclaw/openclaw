import { logTypingFailure } from "openclaw/plugin-sdk/channel-feedback";
import type { ClawdbotConfig, RuntimeEnv } from "../runtime-api.js";
import { addTypingIndicator, removeTypingIndicator, type TypingIndicatorState } from "./typing.js";

const TYPING_INDICATOR_MAX_AGE_MS = 2 * 60_000;
const MS_EPOCH_MIN = 1_000_000_000_000;

function normalizeEpochMs(timestamp: number | undefined): number | undefined {
  if (!Number.isFinite(timestamp) || timestamp === undefined || timestamp <= 0) {
    return undefined;
  }
  // Defensive normalization: some payloads use seconds, others milliseconds.
  // Values below 1e12 are treated as epoch-seconds.
  return timestamp < MS_EPOCH_MIN ? timestamp * 1000 : timestamp;
}

export function createFeishuReplyTyping(params: {
  cfg: ClawdbotConfig;
  accountId?: string;
  messageId?: string;
  messageCreateTimeMs?: number;
  runtime: RuntimeEnv;
  enabled: boolean;
  ownsProcessingFeedback: boolean;
}) {
  let typingState: TypingIndicatorState | null = null;
  return {
    start: async () => {
      if (params.ownsProcessingFeedback || !params.enabled) {
        return;
      }
      if (!params.messageId) {
        return;
      }
      // Skip typing indicator for old messages — likely replays after context
      // compaction that would flood users with stale notifications (#30418).
      const messageCreateTimeMs = normalizeEpochMs(params.messageCreateTimeMs);
      if (
        messageCreateTimeMs !== undefined &&
        Date.now() - messageCreateTimeMs > TYPING_INDICATOR_MAX_AGE_MS
      ) {
        return;
      }
      // Feishu reactions persist until explicitly removed, so skip keepalive
      // re-adds when a reaction already exists. Re-adding the same emoji
      // triggers a new push notification for every call (#28660).
      if (typingState?.reactionId) {
        return;
      }
      typingState = await addTypingIndicator({
        cfg: params.cfg,
        messageId: params.messageId,
        accountId: params.accountId,
        runtime: params.runtime,
      });
    },
    stop: async () => {
      if (!typingState) {
        return;
      }
      await removeTypingIndicator({
        cfg: params.cfg,
        state: typingState,
        accountId: params.accountId,
        runtime: params.runtime,
      });
      typingState = null;
    },
    onStartError: (err: unknown) =>
      logTypingFailure({
        log: (message) => params.runtime.log?.(message),
        channel: "feishu",
        action: "start",
        error: err,
      }),
    onStopError: (err: unknown) =>
      logTypingFailure({
        log: (message) => params.runtime.log?.(message),
        channel: "feishu",
        action: "stop",
        error: err,
      }),
  };
}
