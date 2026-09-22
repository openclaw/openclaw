// Msteams plugin module implements reaction handler behavior.
import { normalizeMSTeamsConversationId } from "../inbound.js";
import type { MSTeamsMessageHandlerDeps } from "../monitor-handler.types.js";
import { resolveMSTeamsReactionEmoji } from "../reaction-types.js";
import { getMSTeamsRuntime } from "../runtime.js";
import type { MSTeamsTurnContext } from "../sdk-types.js";
import { resolveMSTeamsSenderAccess } from "./access.js";

type ReactionDirection = "added" | "removed";

/**
 * Create a handler for MS Teams reaction activities (reactionsAdded / reactionsRemoved).
 * The returned function accepts a turn context and a direction string.
 */
export function createMSTeamsReactionHandler(deps: MSTeamsMessageHandlerDeps) {
  const { cfg, log } = deps;
  const core = getMSTeamsRuntime();
  const msteamsCfg = cfg.channels?.msteams;

  return async function handleReaction(
    context: MSTeamsTurnContext,
    direction: ReactionDirection,
  ): Promise<void> {
    const activity = context.activity;

    // Reactions are carried in reactionsAdded / reactionsRemoved on the activity.
    const rawReactions =
      direction === "added" ? activity.reactionsAdded : activity.reactionsRemoved;
    const reactions: Array<{ type?: string }> = Array.isArray(rawReactions) ? rawReactions : [];

    if (reactions.length === 0) {
      log.debug?.("reaction activity has no reactions; skipping");
      return;
    }

    const from = activity.from;
    if (!from?.id) {
      log.debug?.("reaction activity missing from.id; skipping");
      return;
    }

    const rawConversationId = activity.conversation?.id ?? "";
    const conversationId = normalizeMSTeamsConversationId(rawConversationId);
    const isChannel = activity.conversation?.conversationType === "channel";

    const senderId = from.aadObjectId ?? from.id;
    const senderName = from.name ?? from.id;

    // A reaction enqueues a session-scoped event, so it must reuse the message admission
    // classification and gates. Re-deriving direct/group locally lets a conversation that
    // admission treats as direct route into a team-scoped session without the team/channel gate.
    const access = await resolveMSTeamsSenderAccess({ cfg, activity });
    const { isDirectMessage, channelGate } = access;
    if (access.hasConflictingConversationScope) {
      // Bot Framework marks group and channel conversations as non-personal. Fail closed when
      // their scope metadata contradicts a personal conversation instead of choosing a session.
      log.info("dropping reaction (conflicting conversation scope)", { conversationId });
      return;
    }

    if (msteamsCfg) {
      if (access.senderAccess.decision !== "allow") {
        log.debug?.("dropping reaction (access denied)", {
          sender: senderId,
          reason: access.senderAccess.reasonCode,
        });
        return;
      }
      if (!isDirectMessage && channelGate.allowlistConfigured && !channelGate.allowed) {
        log.info("dropping reaction (not in team/channel allowlist)", {
          conversationId,
          teamKey: channelGate.teamKey ?? "none",
          channelKey: channelGate.channelKey ?? "none",
          channelMatchKey: channelGate.channelMatchKey ?? "none",
          channelMatchSource: channelGate.channelMatchSource ?? "none",
        });
        return;
      }
    }

    // Resolve the agent route for this conversation/sender.
    // Extract teamId for team-scoped routing bindings (channel/group reactions).
    const teamId = isDirectMessage ? undefined : activity.channelData?.team?.id;
    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "msteams",
      peer: {
        kind: isDirectMessage ? "direct" : isChannel ? "channel" : "group",
        id: isDirectMessage ? senderId : conversationId,
      },
      ...(teamId ? { teamId } : {}),
    });

    // The replyToId points to the message that was reacted to.
    const targetMessageId = activity.replyToId ?? "unknown";

    for (const reaction of reactions) {
      const reactionType = reaction.type ?? "unknown";
      const emoji = resolveMSTeamsReactionEmoji(reactionType);
      const label =
        direction === "added"
          ? `Teams reaction ${emoji} added by ${senderName} on message ${targetMessageId}`
          : `Teams reaction ${emoji} removed by ${senderName} from message ${targetMessageId}`;

      log.info(`reaction ${direction}`, {
        sender: senderId,
        reactionType,
        emoji,
        targetMessageId,
        conversationId,
      });

      core.system.enqueueSystemEvent(label, {
        sessionKey: route.sessionKey,
        contextKey: `msteams:reaction:${conversationId}:${targetMessageId}:${senderId}:${reactionType}:${direction}`,
      });
    }
  };
}
