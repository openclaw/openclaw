import { parseTelegramTarget } from "./targets.js";

export function resolveTelegramAutoThreadId(params: {
  to: string;
  toolContext?: { currentThreadTs?: string; currentChannelId?: string };
}): string | undefined {
  const context = params.toolContext;
  if (!context?.currentThreadTs || !context.currentChannelId) {
    return undefined;
  }
  const parsedTo = parseTelegramTarget(params.to);
  const parsedChannel = parseTelegramTarget(context.currentChannelId);
  if (parsedTo.chatId.toLowerCase() !== parsedChannel.chatId.toLowerCase()) {
    return undefined;
  }
  return context.currentThreadTs;
}
