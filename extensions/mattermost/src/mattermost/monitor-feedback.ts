import {
  createStatusReactionController,
  logAckFailure,
  resolveAckReaction,
  shouldAckReaction,
  type StatusReactionAdapter,
  type StatusReactionController,
} from "openclaw/plugin-sdk/channel-feedback";
import { normalizeMattermostEmojiName } from "./emoji.js";
import type { MattermostMonitorContext } from "./monitor-types.js";

export type MattermostMessageFeedback = {
  /** Null when no acknowledgement reaction applies to this post. */
  controller: StatusReactionController | null;
  /** Add the acknowledgement reaction; call once the post is admitted for a turn. */
  queueAck: () => void;
  finish: (outcome: { error: boolean }) => Promise<void>;
};

/**
 * Acknowledgement and lifecycle status reactions on the inbound post, matching
 * Telegram, Discord, Slack and WhatsApp: `messages.ackReactionScope` decides when the
 * ack emoji is added and `messages.statusReactions` lets it cycle through
 * thinking/tool/done/error while the run progresses.
 */
export function createMattermostMessageFeedback(params: {
  monitor: MattermostMonitorContext;
  agentId: string;
  postId: string;
  kind: "direct" | "group" | "channel";
  canDetectMention: boolean;
  effectiveWasMentioned: boolean;
  shouldBypassMention: boolean;
}): MattermostMessageFeedback {
  const { monitor, postId } = params;
  const { account, botUserId, cfg, client } = monitor;
  const ackReaction = normalizeMattermostEmojiName(
    resolveAckReaction(cfg, params.agentId, {
      channel: "mattermost",
      accountId: account.accountId,
    }),
  );
  const isGroup = params.kind !== "direct";
  const shouldSendAck =
    Boolean(ackReaction) &&
    shouldAckReaction({
      scope: cfg.messages?.ackReactionScope,
      isDirect: !isGroup,
      isGroup,
      isMentionableGroup: isGroup,
      canDetectMention: params.canDetectMention,
      effectiveWasMentioned: params.effectiveWasMentioned,
      shouldBypassMention: params.shouldBypassMention,
    });
  const statusReactionsEnabled = shouldSendAck && cfg.messages?.statusReactions?.enabled !== false;
  const logFailure = (error: unknown) =>
    logAckFailure({ log: monitor.logVerboseMessage, channel: "mattermost", target: postId, error });
  const adapter: StatusReactionAdapter = {
    setReaction: async (emoji) => {
      const emojiName = normalizeMattermostEmojiName(emoji);
      if (!emojiName) {
        return;
      }
      await client.request<void>("/reactions", {
        method: "POST",
        body: JSON.stringify({ user_id: botUserId, post_id: postId, emoji_name: emojiName }),
      });
    },
    removeReaction: async (emoji) => {
      const emojiName = normalizeMattermostEmojiName(emoji);
      if (!emojiName) {
        return;
      }
      await client.request<void>(
        `/users/${encodeURIComponent(botUserId)}/posts/${encodeURIComponent(postId)}/reactions/${encodeURIComponent(emojiName)}`,
        { method: "DELETE" },
      );
    },
  };
  const controller =
    shouldSendAck && ackReaction
      ? createStatusReactionController({
          enabled: statusReactionsEnabled,
          adapter,
          initialEmoji: ackReaction,
          presentation: "acknowledgement",
          onError: logFailure,
        })
      : null;
  let acked = false;
  return {
    controller: statusReactionsEnabled ? controller : null,
    queueAck: () => {
      if (acked || !shouldSendAck || !ackReaction) {
        return;
      }
      acked = true;
      if (statusReactionsEnabled && controller) {
        void controller.setQueued();
        return;
      }
      void adapter.setReaction(ackReaction).catch(logFailure);
    },
    finish: async ({ error }) => {
      if (!acked || !statusReactionsEnabled || !controller) {
        return;
      }
      if (error) {
        await controller.setError();
      } else {
        await controller.setDone();
      }
      void controller.restoreInitial();
    },
  };
}
