import {
  createAckReactionHandle,
  logAckFailure,
  removeAckReactionHandleAfterReply,
  resolveAckReaction,
  shouldAckReaction,
  type AckReactionHandle,
  type AckReactionScope,
} from "openclaw/plugin-sdk/channel-feedback";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import {
  addMattermostReaction,
  normalizeMattermostReactionEmojiName,
  removeMattermostReaction,
} from "./reactions.js";
import type { ChatType, OpenClawConfig } from "./runtime-api.js";

export type MattermostAckReactionScope = AckReactionScope;

export function resolveMattermostAckReactionConfig(params: {
  cfg: OpenClawConfig;
  agentId: string;
  accountId?: string | null;
}): {
  ackReaction: string;
  ackReactionScope: MattermostAckReactionScope;
  removeAckAfterReply: boolean;
} {
  const ackReaction = normalizeMattermostReactionEmojiName(
    resolveAckReaction(params.cfg, params.agentId, {
      channel: "mattermost",
      accountId: params.accountId ?? undefined,
    }),
  );
  const ackReactionScope = (params.cfg.messages?.ackReactionScope ??
    "group-mentions") as MattermostAckReactionScope;
  const removeAckAfterReply = params.cfg.messages?.removeAckAfterReply ?? false;
  return {
    ackReaction,
    ackReactionScope,
    removeAckAfterReply,
  };
}

export function shouldSendMattermostAckReaction(params: {
  scope: MattermostAckReactionScope;
  kind: ChatType;
  shouldRequireMention: boolean;
  canDetectMention: boolean;
  effectiveWasMentioned: boolean;
  shouldBypassMention: boolean;
}): boolean {
  return shouldAckReaction({
    scope: params.scope,
    isDirect: params.kind === "direct",
    isGroup: params.kind !== "direct",
    isMentionableGroup: params.kind !== "direct",
    requireMention: params.shouldRequireMention,
    canDetectMention: params.canDetectMention,
    effectiveWasMentioned: params.effectiveWasMentioned,
    shouldBypassMention: params.shouldBypassMention,
  });
}

export function createMattermostAckReaction(params: {
  cfg: OpenClawConfig;
  agentId: string;
  accountId?: string | null;
  channelId: string;
  postId?: string | null;
  kind: ChatType;
  shouldRequireMention: boolean;
  canDetectMention: boolean;
  effectiveWasMentioned: boolean;
  shouldBypassMention: boolean;
  reactionsEnabled: boolean;
  log: (message: string) => void;
}): AckReactionHandle | null {
  const postId = normalizeOptionalString(params.postId);
  if (!postId || !params.reactionsEnabled) {
    return null;
  }

  const { ackReaction, ackReactionScope } = resolveMattermostAckReactionConfig({
    cfg: params.cfg,
    agentId: params.agentId,
    accountId: params.accountId,
  });
  if (!ackReaction) {
    return null;
  }
  if (
    !shouldSendMattermostAckReaction({
      scope: ackReactionScope,
      kind: params.kind,
      shouldRequireMention: params.shouldRequireMention,
      canDetectMention: params.canDetectMention,
      effectiveWasMentioned: params.effectiveWasMentioned,
      shouldBypassMention: params.shouldBypassMention,
    })
  ) {
    return null;
  }

  const target = `${params.channelId}/${postId}`;
  return createAckReactionHandle({
    ackReactionValue: ackReaction,
    send: async () => {
      const result = await addMattermostReaction({
        cfg: params.cfg,
        postId,
        emojiName: ackReaction,
        accountId: params.accountId,
      });
      if (!result.ok) {
        throw new Error(result.error);
      }
    },
    remove: async () => {
      const result = await removeMattermostReaction({
        cfg: params.cfg,
        postId,
        emojiName: ackReaction,
        accountId: params.accountId,
      });
      if (!result.ok) {
        throw new Error(result.error);
      }
    },
    onSendError: (err) => {
      logAckFailure({
        log: params.log,
        channel: "mattermost",
        target,
        error: err,
      });
    },
  });
}

export function cleanupMattermostAckReaction(params: {
  ackReaction: AckReactionHandle | null | undefined;
  didSendReply: boolean;
  removeAckAfterReply: boolean;
  target: string;
  log: (message: string) => void;
}): void {
  removeAckReactionHandleAfterReply({
    removeAfterReply: params.removeAckAfterReply && params.didSendReply,
    ackReaction: params.ackReaction,
    onError: (err) => {
      logAckFailure({
        log: params.log,
        channel: "mattermost",
        target: params.target,
        error: err,
      });
    },
  });
}
