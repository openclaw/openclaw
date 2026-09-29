import { stringifyRouteThreadId } from "../../plugin-sdk/channel-route.js";
import { normalizeOptionalAccountId } from "../../routing/account-id.js";
import { resolveMessageChannel } from "../../utils/message-channel.js";
import type { AgentCommandOpts, AgentRunContext } from "./types.js";

/** Merges explicit run context with command routing options. */
export function resolveAgentRunContext(opts: AgentCommandOpts): AgentRunContext {
  const merged: AgentRunContext = opts.runContext ? { ...opts.runContext } : {};

  const normalizedChannel = resolveMessageChannel(
    merged.messageChannel ?? opts.messageChannel,
    opts.replyChannel ?? opts.channel,
  );
  if (normalizedChannel) {
    merged.messageChannel = normalizedChannel;
  }

  const normalizedAccountId = normalizeOptionalAccountId(merged.accountId ?? opts.accountId);
  if (normalizedAccountId) {
    merged.accountId = normalizedAccountId;
  }

  for (const key of ["groupId", "groupChannel", "groupSpace"] as const) {
    const value = (merged[key] ?? opts[key])?.toString().trim();
    if (value) {
      merged[key] = value;
    }
  }

  if (merged.currentThreadTs == null) {
    const threadId = stringifyRouteThreadId(opts.threadId);
    if (threadId) {
      merged.currentThreadTs = threadId;
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
