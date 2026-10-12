import { logTypingFailure } from "openclaw/plugin-sdk/channel-feedback";
import type { ClawdbotConfig, RuntimeEnv } from "../runtime-api.js";
import { isFeishuMessageFeedbackStale } from "./message-feedback-age.js";
import { addTypingIndicator, removeTypingIndicator, type TypingIndicatorState } from "./typing.js";

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
      if (isFeishuMessageFeedbackStale(params.messageCreateTimeMs)) {
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
