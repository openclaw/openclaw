import {
  DEFAULT_ACCOUNT_ID,
  createScopedPairingAccess,
  readStoreAllowFromForDmPolicy,
  resolveEffectiveAllowFromLists,
  resolveDmGroupAccessWithLists,
  resolveDefaultGroupPolicy,
  isDangerousNameMatchingEnabled,
} from "openclaw/plugin-sdk/msteams";
import { normalizeMSTeamsConversationId } from "../inbound.js";
import type { MSTeamsMessageHandlerDeps } from "../monitor-handler.js";
import { resolveMSTeamsAllowlistMatch, resolveMSTeamsRouteConfig } from "../policy.js";
import { getMSTeamsRuntime } from "../runtime.js";
import type { MSTeamsTurnContext } from "../sdk-types.js";

/**
 * Emoji mapping for Teams reaction type names.
 */
const REACTION_EMOJI: Record<string, string> = {
  like: "👍",
  heart: "❤️",
  laugh: "😆",
  surprised: "😮",
  sad: "😢",
  angry: "😡",
};

function reactionEmoji(type: string): string {
  return REACTION_EMOJI[type] ?? type;
}

export function createMSTeamsReactionHandler(deps: MSTeamsMessageHandlerDeps) {
  const { cfg, log } = deps;
  const core = getMSTeamsRuntime();
  const pairing = createScopedPairingAccess({
    core,
    channel: "msteams",
    accountId: DEFAULT_ACCOUNT_ID,
  });
  const msteamsCfg = cfg.channels?.msteams;

  return async function handleTeamsReaction(
    context: MSTeamsTurnContext,
    direction: "added" | "removed",
  ) {
    const activity = context.activity;
    const from = activity.from;
    if (!from?.id) {
      log.debug?.("skipping reaction without from.id");
      return;
    }

    const reactions =
      direction === "added"
        ? (activity as unknown as { reactionsAdded?: Array<{ type: string }> }).reactionsAdded
        : (activity as unknown as { reactionsRemoved?: Array<{ type: string }> }).reactionsRemoved;

    if (!reactions || reactions.length === 0) {
      log.debug?.("skipping reaction event with no reactions");
      return;
    }

    const conversation = activity.conversation;
    const rawConversationId = conversation?.id ?? "";
    const conversationId = normalizeMSTeamsConversationId(rawConversationId);
    const conversationType = conversation?.conversationType ?? "personal";
    const isGroupChat = conversationType === "groupChat" || conversation?.isGroup === true;
    const isChannel = conversationType === "channel";
    const isDirectMessage = !isGroupChat && !isChannel;

    const senderName = from.name ?? from.id;
    const senderId = from.aadObjectId ?? from.id;
    const replyToId = activity.replyToId ?? undefined;

    const teamId = activity.channelData?.team?.id;
    const teamName = activity.channelData?.team?.name;
    const channelName = activity.channelData?.channel?.name;

    // Authorization — reuse the same allowlist logic as message-handler
    const dmPolicy = msteamsCfg?.dmPolicy ?? "pairing";
    const storedAllowFrom = await readStoreAllowFromForDmPolicy({
      provider: "msteams",
      accountId: pairing.accountId,
      dmPolicy,
      readStore: pairing.readStoreForDmPolicy,
    });

    const dmAllowFrom = msteamsCfg?.allowFrom ?? [];
    const configuredDmAllowFrom = dmAllowFrom.map((v) => String(v));
    const groupAllowFrom = msteamsCfg?.groupAllowFrom;
    const resolvedAllowFromLists = resolveEffectiveAllowFromLists({
      allowFrom: configuredDmAllowFrom,
      groupAllowFrom,
      storeAllowFrom: storedAllowFrom,
      dmPolicy,
    });
    const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
    const groupPolicy =
      !isDirectMessage && msteamsCfg
        ? (msteamsCfg.groupPolicy ?? defaultGroupPolicy ?? "allowlist")
        : "disabled";
    const effectiveGroupAllowFrom = resolvedAllowFromLists.effectiveGroupAllowFrom;
    const channelGate = resolveMSTeamsRouteConfig({
      cfg: msteamsCfg,
      teamId,
      teamName,
      conversationId,
      channelName,
    });
    const senderGroupPolicy =
      groupPolicy === "disabled"
        ? "disabled"
        : effectiveGroupAllowFrom.length > 0
          ? "allowlist"
          : "open";
    const access = resolveDmGroupAccessWithLists({
      isGroup: !isDirectMessage,
      dmPolicy,
      groupPolicy: senderGroupPolicy,
      allowFrom: configuredDmAllowFrom,
      groupAllowFrom,
      storeAllowFrom: storedAllowFrom,
      groupAllowFromFallbackToAllowFrom: false,
      isSenderAllowed: (allowFrom) =>
        resolveMSTeamsAllowlistMatch({
          allowFrom,
          senderId,
          senderName,
          allowNameMatching: isDangerousNameMatchingEnabled(msteamsCfg),
        }).allowed,
    });

    if (access.decision !== "allow") {
      log.debug?.("reaction from unauthorized sender, ignoring", {
        senderId,
        senderName,
        decision: access.decision,
        reason: access.reason,
      });
      return;
    }

    // Group policy gating — mirror message-handler logic
    if (!isDirectMessage && msteamsCfg) {
      if (groupPolicy === "disabled") {
        log.debug?.("dropping group reaction (groupPolicy: disabled)", {
          conversationId,
        });
        return;
      }

      if (groupPolicy === "allowlist") {
        if (channelGate.allowlistConfigured && !channelGate.allowed) {
          log.debug?.("dropping group reaction (not in team/channel allowlist)", {
            conversationId,
            teamKey: channelGate.teamKey ?? "none",
            channelKey: channelGate.channelKey ?? "none",
            channelMatchKey: channelGate.channelMatchKey ?? "none",
            channelMatchSource: channelGate.channelMatchSource ?? "none",
          });
          return;
        }
        if (effectiveGroupAllowFrom.length === 0 && !channelGate.allowlistConfigured) {
          log.debug?.("dropping group reaction (groupPolicy: allowlist, no allowlist)", {
            conversationId,
          });
          return;
        }
        if (effectiveGroupAllowFrom.length > 0 && access.decision !== "allow") {
          log.debug?.("dropping group reaction (not in groupAllowFrom)", {
            senderId,
            senderName,
          });
          return;
        }
      }
    }

    // Resolve agent route
    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "msteams",
      peer: {
        kind: isDirectMessage ? "direct" : isChannel ? "channel" : "group",
        id: isDirectMessage ? senderId : conversationId,
      },
    });

    // Build the reaction summary
    const reactionTypes = reactions.map((r) => reactionEmoji(r.type)).join(", ");
    const directionLabel = direction === "added" ? "reacted" : "removed reaction";
    const targetLabel = replyToId ? ` on message ${replyToId}` : "";
    const chatLabel = isDirectMessage ? `Teams DM` : `Teams ${conversationType}`;

    const summary = `${chatLabel}: ${senderName} ${directionLabel} ${reactionTypes}${targetLabel}`;

    log.info("reaction event", {
      direction,
      reactions: reactions.map((r) => r.type),
      senderId,
      senderName,
      replyToId,
      conversationId,
    });

    // Fire system event — agent sees this in context without triggering an LLM call
    core.system.enqueueSystemEvent(summary, {
      sessionKey: route.sessionKey,
      contextKey: `msteams:reaction:${conversationId}:${direction}:${activity.id ?? Date.now()}`,
    });
  };
}
