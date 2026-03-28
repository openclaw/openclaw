import {
  buildPluginBindingResolvedText,
  parsePluginBindingApprovalCustomId,
  resolvePluginConversationBindingApproval,
} from "openclaw/plugin-sdk/conversation-runtime";
import {
  dispatchPluginInteractiveHandler,
  type PluginInteractiveMSTeamsHandlerContext,
} from "openclaw/plugin-sdk/plugin-runtime";
import { DEFAULT_ACCOUNT_ID, type OpenClawConfig } from "../runtime-api.js";
import { normalizeMSTeamsConversationId } from "./inbound.js";
import type { MSTeamsMessageHandlerDeps } from "./monitor-handler.js";
import { resolveMSTeamsSenderAccess } from "./monitor-handler/access.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";

type InteractiveEnvelope = {
  version?: unknown;
  data?: unknown;
};

type InteractiveEnvelopeContainer = {
  openclawInteractive?: InteractiveEnvelope;
  replyToId?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeConversationType(
  value: string | undefined,
): PluginInteractiveMSTeamsHandlerContext["conversationType"] {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "personal") {
    return "personal";
  }
  if (normalized === "channel") {
    return "channel";
  }
  if (normalized === "groupchat") {
    return "groupChat";
  }
  return undefined;
}

function buildAdaptiveCardAttachment(card: Record<string, unknown>) {
  return {
    contentType: "application/vnd.microsoft.card.adaptive",
    content: card,
  };
}

async function sendTextOrCard(
  context: MSTeamsTurnContext,
  params: { text?: string; card?: Record<string, unknown>; replyToId?: string },
): Promise<void> {
  if (params.card) {
    await context.sendActivity({
      type: "message",
      ...(params.text !== undefined ? { text: params.text } : {}),
      ...(params.replyToId ? { replyToId: params.replyToId } : {}),
      attachments: [buildAdaptiveCardAttachment(params.card)],
    });
    return;
  }
  await context.sendActivity({
    type: "message",
    text: params.text ?? "",
    ...(params.replyToId ? { replyToId: params.replyToId } : {}),
  });
}

async function editSourceMessage(
  context: MSTeamsTurnContext,
  messageId: string,
  params: { text?: string; card?: Record<string, unknown>; clearCard?: boolean },
): Promise<void> {
  await context.updateActivity({
    type: "message",
    id: messageId,
    ...(params.text !== undefined ? { text: params.text } : {}),
    ...(params.card
      ? { attachments: [buildAdaptiveCardAttachment(params.card)] }
      : params.clearCard
        ? { attachments: [] }
        : {}),
  });
}

function extractInteractiveData(value: unknown): string | null {
  const typed = asRecord(value) as InteractiveEnvelopeContainer | null;
  const envelope = asRecord(typed?.openclawInteractive) as InteractiveEnvelope | null;
  const data = typeof envelope?.data === "string" ? envelope.data.trim() : "";
  return data || null;
}

function extractSourceMessageId(activity: MSTeamsTurnContext["activity"]): string | undefined {
  const topLevel = typeof activity.replyToId === "string" ? activity.replyToId.trim() : "";
  if (topLevel) {
    return topLevel;
  }
  const valueReplyToId = asRecord(activity.value)?.replyToId;
  return typeof valueReplyToId === "string" && valueReplyToId.trim()
    ? valueReplyToId.trim()
    : undefined;
}

function isAuthorizedInteractiveSender(params: {
  cfg: OpenClawConfig;
  resolved: Awaited<ReturnType<typeof resolveMSTeamsSenderAccess>>;
}): boolean {
  const { cfg, resolved } = params;
  if (!cfg.channels?.msteams) {
    return true;
  }
  if (resolved.isDirectMessage) {
    return resolved.access.decision === "allow";
  }
  if (resolved.channelGate.allowlistConfigured && !resolved.channelGate.allowed) {
    return false;
  }
  return resolved.senderGroupAccess.allowed;
}

function buildPluginConversationId(params: {
  isDirectMessage: boolean;
  senderId: string;
  conversationId: string;
}): string {
  return params.isDirectMessage
    ? `user:${params.senderId}`
    : `conversation:${params.conversationId}`;
}

export async function handleMSTeamsPluginInteraction(params: {
  context: MSTeamsTurnContext;
  deps: MSTeamsMessageHandlerDeps;
}): Promise<boolean> {
  const { context, deps } = params;
  const activity = context.activity;
  if (activity.type !== "invoke" || activity.name !== "message/submitAction") {
    return false;
  }

  const data = extractInteractiveData(activity.value);
  if (!data) {
    return false;
  }

  const resolvedAccess = await resolveMSTeamsSenderAccess({
    cfg: deps.cfg,
    activity,
  });
  const isAuthorizedSender = isAuthorizedInteractiveSender({
    cfg: deps.cfg,
    resolved: resolvedAccess,
  });
  const senderId = resolvedAccess.senderId;
  const senderUsername = activity.from?.name ?? undefined;
  const normalizedConversationId = normalizeMSTeamsConversationId(
    activity.conversation?.id ?? resolvedAccess.conversationId,
  );
  if (!normalizedConversationId) {
    deps.log.debug?.("dropping Teams plugin interaction without conversation id", {
      activityId: activity.id,
    });
    return true;
  }

  const messageId = extractSourceMessageId(activity);
  const respond: PluginInteractiveMSTeamsHandlerContext["respond"] = {
    acknowledge: async () => {},
    reply: async (reply) => {
      await sendTextOrCard(context, { ...reply, replyToId: messageId });
    },
    followUp: async (reply) => {
      if (!messageId) {
        await sendTextOrCard(context, reply);
        return;
      }
      try {
        await sendTextOrCard(context, { ...reply, replyToId: messageId });
      } catch {
        // Some fallback paths reach followUp because the source message could
        // not be updated anymore (for example it was deleted). Retry without a
        // replyToId so the user still sees the approval/result message.
        await sendTextOrCard(context, reply);
      }
    },
    editMessage: async (reply) => {
      if (!messageId) {
        throw new Error("Teams interaction is missing replyToId for editMessage");
      }
      await editSourceMessage(context, messageId, reply);
    },
    clearActions: async (reply) => {
      if (!messageId) {
        throw new Error("Teams interaction is missing replyToId for clearActions");
      }
      await editSourceMessage(context, messageId, {
        text: reply?.text ?? "Actions cleared.",
        clearCard: true,
      });
    },
    deleteMessage: async () => {
      if (!messageId) {
        throw new Error("Teams interaction is missing replyToId for deleteMessage");
      }
      await context.deleteActivity(messageId);
    },
  };

  if (!isAuthorizedSender) {
    deps.log.debug?.("dropping Teams plugin interaction from unauthorized sender", {
      senderId,
      conversationId: normalizedConversationId,
    });
    await respond.reply({ text: "You are not allowed to use that action." }).catch(() => undefined);
    return true;
  }

  const bindingApproval = parsePluginBindingApprovalCustomId(data);
  if (bindingApproval) {
    const resolved = await resolvePluginConversationBindingApproval({
      approvalId: bindingApproval.approvalId,
      decision: bindingApproval.decision,
      senderId,
    });
    const resolvedText = buildPluginBindingResolvedText(resolved);
    let updatedSource = false;
    if (messageId) {
      updatedSource = await respond
        .clearActions({ text: resolvedText })
        .then(() => true)
        .catch(() => false);
    }
    if (!updatedSource) {
      await respond.followUp({ text: resolvedText }).catch(() => undefined);
    }
    return true;
  }

  const pluginConversationId = buildPluginConversationId({
    isDirectMessage: resolvedAccess.isDirectMessage,
    senderId,
    conversationId: normalizedConversationId,
  });
  const interactionId = activity.id?.trim() || `${pluginConversationId}:${messageId ?? data}`;
  const dispatched = await dispatchPluginInteractiveHandler({
    channel: "msteams",
    data,
    interactionId,
    ctx: {
      accountId: resolvedAccess.pairing.accountId ?? DEFAULT_ACCOUNT_ID,
      interactionId,
      conversationId: pluginConversationId,
      senderId,
      senderUsername,
      auth: { isAuthorizedSender },
      conversationType: normalizeConversationType(activity.conversation?.conversationType),
      teamId: activity.channelData?.team?.id,
      graphChannelId: activity.channelData?.channel?.id,
      interaction: {
        kind: "submit",
        messageId,
        value: activity.value,
      },
    },
    respond,
  });
  return dispatched.matched && dispatched.handled;
}
