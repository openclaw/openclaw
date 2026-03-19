import { normalizeAccountId } from "../../utils/account-id.js";
import { resolveMessageChannel } from "../../utils/message-channel.js";
import type { AgentCommandOpts, AgentRunContext } from "./types.js";

export function resolveAgentRunContext(opts: AgentCommandOpts): AgentRunContext {
  const merged: AgentRunContext = opts.runContext ? { ...opts.runContext } : {};

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

  const inferredSessionThreadId = (() => {
    const sessionKey = opts.sessionKey?.trim();
    if (!sessionKey) {
      return undefined;
    }
    const match = sessionKey.match(
      /^(?:agent:[^:]+:)?[^:]+:(?:group|channel):.+:(?:topic|thread):([^:]+)(?::sender:[^:]+)?$/,
    );
    return match?.[1]?.trim() || undefined;
  })();

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
  }

  return merged;
}
