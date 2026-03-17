import type {
  ChannelThreadingContext,
  ChannelThreadingToolContext,
} from "openclaw/plugin-sdk/channel-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { resolveSlackAccount, resolveSlackReplyToMode } from "./accounts.js";

export function buildSlackThreadingToolContext(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  context: ChannelThreadingContext;
  hasRepliedRef?: { value: boolean };
}): ChannelThreadingToolContext {
  const account = resolveSlackAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const configuredReplyToMode = resolveSlackReplyToMode(account, params.context.ChatType);
  const hasExplicitThreadTarget = params.context.MessageThreadId != null;
  const effectiveReplyToMode = hasExplicitThreadTarget ? "all" : configuredReplyToMode;
  const threadId = params.context.MessageThreadId ?? params.context.ReplyToId;
  // For channel messages, To is "channel:C…" — extract the bare ID.
  // For DMs, To is "user:U…" which can't be used for reactions; fall back
  // to NativeChannelId (the raw Slack channel id, e.g. "D…").
  const currentChannelId = params.context.To?.startsWith("channel:")
    ? params.context.To.slice("channel:".length)
    : params.context.NativeChannelId?.trim() || undefined;
  return {
    currentChannelId,
    currentThreadTs: threadId != null ? String(threadId) : undefined,
    replyToMode: effectiveReplyToMode,
    hasRepliedRef: params.hasRepliedRef,
  };
}
