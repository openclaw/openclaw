import { resolveAckReaction } from "openclaw/plugin-sdk/agent-runtime";
import {
  createStatusReactionController,
  logAckFailure,
  shouldAckReaction as shouldAckReactionGate,
  type StatusReactionAdapter,
  type StatusReactionController,
} from "openclaw/plugin-sdk/channel-feedback";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createDiscordRestClient, createDiscordRuntimeAccountContext } from "../client.js";
import { reactMessageDiscord, removeReactionDiscord } from "../send.js";
import { resolveDiscordTargetChannelId } from "../send.shared.js";
import { resolveDiscordChannelId } from "../target-parsing.js";
import type { DiscordMessagePreflightContext } from "./message-handler.preflight.types.js";

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
  const ackReactionContext = {
    rest: feedbackRest,
    ...createDiscordRuntimeAccountContext({ cfg, accountId }),
  };
  const createReactionAdapter = (channelId: string, messageId: string): StatusReactionAdapter => ({
    setReaction: async (emoji) => {
      await reactMessageDiscord(channelId, messageId, emoji, ackReactionContext);
    },
    removeReaction: async (emoji) => {
      await removeReactionDiscord(channelId, messageId, emoji, ackReactionContext);
    },
  });
  const discordAdapter = createReactionAdapter(messageChannelId, message.id);
  let statusReactionTarget = `${messageChannelId}/${message.id}`;
  let statusReactionsActive = statusReactionsEnabled;
  const logReactionFailure = (target: string, error: unknown) =>
    logAckFailure({ log: logVerbose, channel: "discord", target, error });
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
      onError: (err) => logReactionFailure(statusReactionTarget, err),
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

  const maybeBindToToolReaction = async (payload: {
    name?: string;
    phase?: string;
    args?: Record<string, unknown>;
  }) => {
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
      logReactionFailure(
        `${normalizeOptionalString(args.to) ?? normalizeOptionalString(args.channelId) ?? messageChannelId}/${trackedMessageId}`,
        err,
      );
      return;
    }
    statusReactionTarget = `${trackedChannelId}/${trackedMessageId}`;
    if (statusReactionsActive) {
      void statusReactions.clear();
    }
    statusReactions = createController(
      true,
      createReactionAdapter(trackedChannelId, trackedMessageId),
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
      void statusReactions.setQueued();
      return;
    }
    if (shouldSendAckReaction && ackReaction) {
      void discordAdapter.setReaction(ackReaction).catch((err: unknown) => {
        logReactionFailure(`${messageChannelId}/${message.id}`, err);
      });
    }
  };

  const finish = async (result: {
    dispatchAborted: boolean;
    dispatchError: boolean;
    finalDeliveryFailed: boolean;
  }) => {
    if (!statusReactionsActive) {
      return;
    }
    if (!result.dispatchAborted) {
      if (result.dispatchError || result.finalDeliveryFailed) {
        await statusReactions.setError();
      } else {
        await statusReactions.setDone();
      }
    }
    void statusReactions.restoreInitial();
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
