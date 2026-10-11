import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { authorizeSlackSystemEventSender } from "../auth.js";
import { resolveSlackChannelLabel } from "../channel-config.js";
import type { SlackMonitorContext } from "../context.js";
import type { SlackEventScope } from "../event-scope.js";

type SlackAuthorizedSystemEventContext = {
  channelLabel: string;
  route: { agentId: string; sessionKey: string };
};

export async function authorizeAndResolveSlackSystemEventContext(params: {
  ctx: SlackMonitorContext;
  senderId?: string;
  channelId?: string;
  channelType?: string | null;
  threadTs?: string;
  eventKind: string;
  eventScope?: SlackEventScope;
}): Promise<SlackAuthorizedSystemEventContext | undefined> {
  const { senderId, channelId, channelType, eventKind } = params;
  const ctx = await params.ctx.readRuntimeContext();
  const auth = await authorizeSlackSystemEventSender({
    ctx,
    senderId,
    channelId,
    channelType,
    eventScope: params.eventScope,
    retryNameLookup: eventKind.startsWith("member-"),
  });
  if (!auth.allowed) {
    logVerbose(
      `slack: drop ${eventKind} sender ${senderId ?? "unknown"} channel=${channelId ?? "unknown"} reason=${auth.reason ?? "unauthorized"}`,
    );
    return undefined;
  }

  const channelLabel = resolveSlackChannelLabel({
    channelId,
    channelName: auth.channelName,
  });
  const route = ctx.resolveSlackSystemEventRoute({
    channelId,
    channelType: auth.channelType,
    senderId,
    threadTs: auth.channelType === "im" ? undefined : params.threadTs,
    eventScope: params.eventScope,
  });
  return {
    channelLabel,
    route,
  };
}
