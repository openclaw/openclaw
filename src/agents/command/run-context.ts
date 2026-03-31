import {
  extractDeliveryInfo,
  resolveSessionThreadIdForRouting,
} from "../../config/sessions/delivery-info.js";
import { normalizeAccountId } from "../../utils/account-id.js";
import { resolveMessageChannel } from "../../utils/message-channel.js";
import type { AgentCommandOpts, AgentRunContext } from "./types.js";

export function resolveAgentRunContext(opts: AgentCommandOpts): AgentRunContext {
  const merged: AgentRunContext = opts.runContext ? { ...opts.runContext } : {};
  const trimmedSessionKey = opts.sessionKey?.trim();
  const inferredSessionThreadId = resolveSessionThreadIdForRouting(trimmedSessionKey);
  const inferredDeliveryInfo =
    !opts.to && trimmedSessionKey ? extractDeliveryInfo(trimmedSessionKey) : undefined;

  const normalizedChannel = resolveMessageChannel(
    merged.messageChannel ?? opts.messageChannel,
    opts.replyChannel ?? opts.channel,
  );
  if (normalizedChannel) {
    merged.messageChannel = normalizedChannel;
  }

  const normalizedAccountId = normalizeAccountId(merged.accountId ?? opts.accountId);
  if (normalizedAccountId) {
    merged.accountId = normalizedAccountId;
  }

  const groupId = (merged.groupId ?? opts.groupId)?.toString().trim();
  if (groupId) {
    merged.groupId = groupId;
  }

  const groupChannel = (merged.groupChannel ?? opts.groupChannel)?.toString().trim();
  if (groupChannel) {
    merged.groupChannel = groupChannel;
  }

  const groupSpace = (merged.groupSpace ?? opts.groupSpace)?.toString().trim();
  if (groupSpace) {
    merged.groupSpace = groupSpace;
  }

  if (merged.currentThreadTs == null) {
    if (opts.threadId != null && opts.threadId !== "" && opts.threadId !== null) {
      merged.currentThreadTs = String(opts.threadId);
    } else if (inferredSessionThreadId) {
      merged.currentThreadTs = inferredSessionThreadId;
    }
  }

  // Populate currentChannelId from the outbound target so channel threading
  // adapters can detect same-conversation auto-threading.
  if (!merged.currentChannelId && opts.to) {
    const trimmedTo = opts.to.trim();
    if (trimmedTo) {
      merged.currentChannelId = trimmedTo;
    }
  } else if (!merged.currentChannelId) {
    const inferredTo = inferredDeliveryInfo?.deliveryContext?.to?.trim();
    if (inferredTo) {
      merged.currentChannelId = inferredTo;
    }
  }

  return merged;
}
