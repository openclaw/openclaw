import {
  listWhatsAppAccountIds,
  resolveWhatsAppAccount,
  createActionGate,
  type ChannelMessageActionName,
  type OpenClawConfig,
  resolveWhatsAppReactionLevel,
} from "./channel-actions.runtime.js";
import {
  resolveWhatsAppAllowedReactions,
  resolveWhatsAppWorkIntakeReaction,
} from "./reaction-policy.js";

function areWhatsAppAgentReactionsEnabled(params: { cfg: OpenClawConfig; accountId?: string }) {
  if (!params.cfg.channels?.whatsapp) {
    return false;
  }
  const gate = createActionGate(params.cfg.channels.whatsapp.actions);
  if (!gate("reactions")) {
    return false;
  }
  return resolveWhatsAppReactionLevel({
    cfg: params.cfg,
    accountId: params.accountId,
  }).agentReactionsEnabled;
}

function hasAnyWhatsAppAccountWithAgentReactionsEnabled(cfg: OpenClawConfig) {
  if (!cfg.channels?.whatsapp) {
    return false;
  }
  return listWhatsAppAccountIds(cfg).some((accountId) => {
    const account = resolveWhatsAppAccount({ cfg, accountId });
    if (!account.enabled) {
      return false;
    }
    return areWhatsAppAgentReactionsEnabled({
      cfg,
      accountId,
    });
  });
}

export function resolveWhatsAppAgentReactionGuidance(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}) {
  if (!params.cfg.channels?.whatsapp) {
    return undefined;
  }
  const gate = createActionGate(params.cfg.channels.whatsapp.actions);
  if (!gate("reactions")) {
    return undefined;
  }
  const resolved = resolveWhatsAppReactionLevel({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  if (!resolved.agentReactionsEnabled) {
    return undefined;
  }
  return resolved.agentReactionGuidance;
}

export function resolveWhatsAppAgentReactionExtraGuidance(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}): string[] {
  if (!params.cfg.channels?.whatsapp) {
    return [];
  }
  const guidance: string[] = [];
  const allowedReactions = resolveWhatsAppAllowedReactions({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  if (allowedReactions.length > 0) {
    guidance.push(
      `Allowed WhatsApp reaction emojis: ${allowedReactions.join(" ")}. Do not use substitutions or generic defaults outside this set.`,
    );
  }
  const workIntakeReaction = resolveWhatsAppWorkIntakeReaction({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  if (workIntakeReaction) {
    guidance.push(
      `For clear work intake that will require tools, source changes, document work, backend work, or waiting on the WhatsApp frontend, the default acknowledgment reaction is ${workIntakeReaction.emoji}.`,
    );
  }
  guidance.push(
    "Reactions apply in every WhatsApp session without exception: owner DMs, casual group chats, and formal working groups (project rooms, meeting rooms, accountability rooms) alike. A per-group custom system prompt does not suppress this. When a message genuinely lands (humor, warmth, sharp take, agreement, surprise, small win, confirmation, clear work intake), pick the emoji from the allowed set that fits the vibe and react. A well-timed reaction is preferred over silence or a filler acknowledgement line, even in formal contexts. Do not chase coverage: skip routine turns, skip your own replies, and respect the per-sender cooldown.",
  );
  return guidance;
}

export function describeWhatsAppMessageActions(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): { actions: ChannelMessageActionName[] } | null {
  if (!params.cfg.channels?.whatsapp) {
    return null;
  }
  const gate = createActionGate(params.cfg.channels.whatsapp.actions);
  const actions = new Set<ChannelMessageActionName>();
  const canReact =
    params.accountId != null
      ? areWhatsAppAgentReactionsEnabled({
          cfg: params.cfg,
          accountId: params.accountId ?? undefined,
        })
      : hasAnyWhatsAppAccountWithAgentReactionsEnabled(params.cfg);
  if (canReact) {
    actions.add("react");
  }
  if (gate("polls")) {
    actions.add("poll");
  }
  return { actions: Array.from(actions) };
}
