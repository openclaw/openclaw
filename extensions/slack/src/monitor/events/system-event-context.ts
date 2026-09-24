import type { AllMiddlewareArgs } from "@slack/bolt";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { authorizeSlackSystemEventSender } from "../auth.js";
import { resolveSlackChannelLabel } from "../channel-config.js";
import type { SlackMonitorContext } from "../context.js";
import { resolveSlackEventScope, type SlackEventScope } from "../event-scope.js";

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
  /**
   * Resolves the target message's thread root for events that carry none (reactions,
   * pins). Runs after sender authorization, and only for non-DM events; receives the
   * authorized channel type and name so the caller can mirror routing config.
   */
  resolveThreadTs?: (context: {
    channelType?: string | null;
    channelName?: string;
  }) => Promise<string | undefined>;
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
  // Direct messages keep their flat session; only channel/group events may name a thread.
  const threadTs =
    auth.channelType === "im"
      ? undefined
      : (params.threadTs ??
        (params.resolveThreadTs
          ? await params.resolveThreadTs({
              channelType: auth.channelType,
              channelName: auth.channelName,
            })
          : undefined));
  const route = ctx.resolveSlackSystemEventRoute({
    channelId,
    channelType: auth.channelType,
    senderId,
    threadTs,
    eventScope: params.eventScope,
  });
  return {
    channelLabel,
    route,
  };
}

export function resolveSlackListenerEventScope(params: {
  ctx: SlackMonitorContext;
  body: unknown;
  context: AllMiddlewareArgs["context"] | undefined;
  client: AllMiddlewareArgs["client"] | undefined;
}): SlackEventScope | null | undefined {
  const resolved = resolveSlackEventScope({
    identity: params.ctx.installationIdentity,
    body: params.body,
    context: params.context,
    client: params.client,
    clientOptions: params.ctx.app.webClientOptions,
  });
  if (!resolved.ok) {
    logVerbose(`slack: drop listener event (${resolved.reason})`);
    return null;
  }
  return resolved.scope;
}
