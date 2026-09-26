import { resolveAckReaction } from "openclaw/plugin-sdk/agent-runtime";
import {
  createStatusReactionController,
  logAckFailure,
  shouldAckReaction as shouldAckReactionGate,
  type StatusReactionController,
} from "openclaw/plugin-sdk/channel-feedback";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createDiscordRestClient } from "../client.js";
import { resolveDiscordTargetChannelId } from "../send.shared.js";
import { resolveDiscordChannelId } from "../targets.js";
import {
  createDiscordAckReactionAdapter,
  createDiscordAckReactionContext,
  queueInitialDiscordAckReaction,
} from "./ack-reactions.js";
import type { DiscordMessagePreflightContext } from "./message-handler.preflight.js";

type ToolStartPayload = {
  name?: string;
  phase?: string;
  args?: Record<string, unknown>;
};

export function createDiscordMessageReactionRuntime(params: {
  ctx: DiscordMessagePreflightContext;
  sourceRepliesAreToolOnly: boolean;
  isRoomEvent: boolean;
}) {
  const { ctx } = params;
  const {
    cfg,
    accountId,
    token,
    ackReactionScope,
    message,
    messageChannelId,
    isGuildMessage,
    isDirectMessage,
    isGroupDm,
    canDetectMention,
    effectiveWasMentioned,
    shouldBypassMention,
    route,
  } = ctx;
  const ackReaction = resolveAckReaction(cfg, route.agentId, {
    channel: "discord",
    accountId,
  });
  const shouldSendAckReaction = Boolean(
    ackReaction &&
    shouldAckReactionGate({
      scope: ackReactionScope,
      inboundEventKind: ctx.inboundEventKind,
      isDirect: isDirectMessage,
      isGroup: isGuildMessage || isGroupDm,
      isMentionableGroup: isGuildMessage,
      canDetectMention,
      effectiveWasMentioned,
      shouldBypassMention,
    }),
  );
  const statusReactionsExplicitlyEnabled = cfg.messages?.statusReactions?.enabled === true;
  const statusReactionsEnabled =
    !params.isRoomEvent &&
    shouldSendAckReaction &&
    cfg.messages?.statusReactions?.enabled !== false &&
    (!params.sourceRepliesAreToolOnly || statusReactionsExplicitlyEnabled);
  const feedbackRest = createDiscordRestClient({ cfg, token, accountId }).rest;
  const deliveryRest = createDiscordRestClient({ cfg, token, accountId }).rest;
  const ackReactionContext = createDiscordAckReactionContext({
    rest: feedbackRest,
    cfg,
    accountId,
  });
  const discordAdapter = createDiscordAckReactionAdapter({
    channelId: messageChannelId,
    messageId: message.id,
    reactionContext: ackReactionContext,
  });
  let statusReactionTarget = `${messageChannelId}/${message.id}`;
  let statusReactionsActive = statusReactionsEnabled;
  const createController = (
    enabled: boolean,
    adapter: Parameters<typeof createStatusReactionController>[0]["adapter"],
    initialEmoji: string,
  ) =>
    createStatusReactionController({
      enabled,
      adapter,
      initialEmoji,
      presentation: "acknowledgement",
      onError: (err) => {
        logAckFailure({
          log: logVerbose,
          channel: "discord",
          target: statusReactionTarget,
          error: err,
        });
      },
    });
  let statusReactions: StatusReactionController = createController(
    statusReactionsEnabled,
    discordAdapter,
    ackReaction,
  );

  const resolveTrackedReactionChannelId = async (
    args: Record<string, unknown>,
  ): Promise<string> => {
    const target =
      normalizeOptionalString(args.channelId) ??
      normalizeOptionalString(args.channel_id) ??
      normalizeOptionalString(args.to);
    if (!target) {
      return messageChannelId;
    }
    try {
      return resolveDiscordChannelId(target);
    } catch {
      return (
        await resolveDiscordTargetChannelId(target, {
          cfg,
          token,
          accountId,
        })
      ).channelId;
    }
  };

  const maybeBindToToolReaction = async (payload: ToolStartPayload) => {
    if (
      params.sourceRepliesAreToolOnly ||
      cfg.messages?.statusReactions?.enabled === false ||
      payload.phase !== "start" ||
      payload.name !== "message" ||
      !payload.args
    ) {
      return;
    }
    const args = payload.args;
    if (normalizeOptionalString(args.action)?.toLowerCase() !== "react") {
      return;
    }
    const shouldTrack = args.trackToolCalls === true || args.track_tool_calls === true;
    if (!shouldTrack) {
      return;
    }
    const emoji = normalizeOptionalString(args.emoji);
    if (!emoji || args.remove === true) {
      return;
    }
    const trackedMessageId =
      normalizeOptionalString(args.messageId) ??
      normalizeOptionalString(args.message_id) ??
      message.id;
    let trackedChannelId: string;
    try {
      trackedChannelId = await resolveTrackedReactionChannelId(args);
    } catch (err) {
      logAckFailure({
        log: logVerbose,
        channel: "discord",
        target: `${normalizeOptionalString(args.to) ?? normalizeOptionalString(args.channelId) ?? messageChannelId}/${trackedMessageId}`,
        error: err,
      });
      return;
    }
    statusReactionTarget = `${trackedChannelId}/${trackedMessageId}`;
    if (statusReactionsActive) {
      void statusReactions.clear();
    }
    statusReactions = createController(
      true,
      createDiscordAckReactionAdapter({
        channelId: trackedChannelId,
        messageId: trackedMessageId,
        reactionContext: ackReactionContext,
      }),
      emoji,
    );
    statusReactionsActive = true;
    void statusReactions.setQueued();
  };

  let initialAckReactionQueued = false;
  const queueInitialAckReactionAfterRecord = () => {
    if (initialAckReactionQueued) {
      return;
    }
    initialAckReactionQueued = true;
    if (statusReactionsEnabled) {
      statusReactionsActive = true;
    }
    queueInitialDiscordAckReaction({
      enabled: statusReactionsEnabled,
      shouldSendAckReaction,
      ackReaction,
      statusReactions,
      reactionAdapter: discordAdapter,
      target: `${messageChannelId}/${message.id}`,
    });
  };

  const finish = async (result: {
    dispatchAborted: boolean;
    dispatchError: boolean;
    finalDeliveryFailed: boolean;
  }) => {
    if (statusReactionsActive) {
      if (result.dispatchAborted) {
        void statusReactions.restoreInitial();
        return;
      }
      if (result.dispatchError || result.finalDeliveryFailed) {
        await statusReactions.setError();
      } else {
        await statusReactions.setDone();
      }
      void statusReactions.restoreInitial();
    }
  };

  return {
    feedbackRest,
    deliveryRest,
    statusReactionsExplicitlyEnabled,
    statusReactionsEnabled,
    get controller() {
      return statusReactions;
    },
    maybeBindToToolReaction,
    queueInitialAckReactionAfterRecord,
    finish,
  };
}
