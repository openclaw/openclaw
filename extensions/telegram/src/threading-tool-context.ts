import type {
  ChannelThreadingContext,
  ChannelThreadingToolContext,
} from "mullusi/plugin-sdk/channel-contract";
import type { MullusiConfig } from "mullusi/plugin-sdk/config-runtime";
import { parseTelegramTarget } from "./targets.js";

function resolveTelegramToolContextThreadId(context: ChannelThreadingContext): string | undefined {
  if (context.MessageThreadId != null) {
    return String(context.MessageThreadId);
  }
  const currentChannelId = context.To?.trim();
  if (!currentChannelId) {
    return undefined;
  }
  const parsedTarget = parseTelegramTarget(currentChannelId);
  return parsedTarget.messageThreadId != null ? String(parsedTarget.messageThreadId) : undefined;
}

export function buildTelegramThreadingToolContext(params: {
  cfg: MullusiConfig;
  accountId?: string | null;
  context: ChannelThreadingContext;
  hasRepliedRef?: { value: boolean };
}): ChannelThreadingToolContext {
  void params.cfg;
  void params.accountId;

  return {
    currentChannelId: params.context.To?.trim() || undefined,
    currentThreadTs: resolveTelegramToolContextThreadId(params.context),
    hasRepliedRef: params.hasRepliedRef,
  };
}
