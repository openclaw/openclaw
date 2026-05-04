import {
  listWhatsAppAccountIds,
  resolveWhatsAppAccount,
  createActionGate,
  type ChannelMessageActionName,
  type OpenClawConfig,
  resolveWhatsAppReactionLevel,
} from "./channel-actions.runtime.js";
import { resolveWhatsAppEmotionPulseGuidance } from "./emotion-pulse.js";
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
      `Allowed WhatsApp selected emojis: ${allowedReactions.join(" ")}. Use this same selected set for WhatsApp reactions and casual text emoji. Do not use substitutions or generic defaults outside this set.`,
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
    ...resolveWhatsAppEmotionPulseGuidance({
      allowedEmojis: allowedReactions,
      workIntakeEmoji: workIntakeReaction?.emoji,
    }),
  );
  guidance.push(
    "Reactions are available in every WhatsApp session, but they are not a coverage target. Do not react to every owner message, every fragment, every routine acknowledgment, or every message you already answered in text. React only when the beat genuinely lands: humor, warmth, surprise, a small win, a clear work handoff, or a moment where a human would visibly acknowledge without adding words. In casual groups, an emoji can also be the entire text reply when that is cleaner than words. A reaction and a text emoji are separate choices: use one, the other, or both only when timing makes it feel human. For group reactions, pass participant from trusted conversation info sender_id for the reacted-to message; never use the group JID, your own JID, or a display name as participant. Do not chase coverage: skip routine turns, skip consecutive fragments, skip your own replies, and respect the per-sender cooldown.",
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
