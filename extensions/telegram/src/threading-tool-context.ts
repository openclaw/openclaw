import type {
  ChannelThreadingContext,
  ChannelThreadingToolContext,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { parseTelegramTarget } from "./targets.js";

export function buildTelegramThreadingToolContext(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  context: ChannelThreadingContext;
  hasRepliedRef?: { value: boolean };
}): ChannelThreadingToolContext {
  const currentChannelId = normalizeOptionalString(params.context.To);
  const threadId =
    params.context.MessageThreadId ??
    (currentChannelId ? parseTelegramTarget(currentChannelId).messageThreadId : undefined);
  return {
    currentChannelId,
    currentThreadTs: threadId != null ? String(threadId) : undefined,
    hasRepliedRef: params.hasRepliedRef,
  };
}
