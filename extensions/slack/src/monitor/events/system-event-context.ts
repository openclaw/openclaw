// Slack plugin module implements system event context behavior.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { authorizeSlackSystemEventSender } from "../auth.js";
import { resolveSlackChannelLabel } from "../channel-config.js";
import type { SlackMonitorContext } from "../context.js";
import { resolveSlackIngressTurnLifecycle } from "../ingress.js";

type SlackAuthorizedSystemEventContext = {
  channelLabel: string;
  sessionKey: string;
};

/** Stable identity for one Events API occurrence, independent of its state-shaped subject. */
export function resolveSlackSystemEventOccurrenceId(params: {
  body: unknown;
  eventTs?: string | null;
}): string {
  const rawEventId = asOptionalRecord(params.body)?.event_id;
  const eventId = typeof rawEventId === "string" ? rawEventId.trim() : "";
  return eventId || params.eventTs?.trim() || "unknown";
}

/** Retry durable Events API work, while preserving legacy direct-handler logging. */
export function handleSlackSystemEventFailure(params: {
  ctx: SlackMonitorContext;
  context: unknown;
  error: unknown;
  label: string;
}): void {
  if (resolveSlackIngressTurnLifecycle(params.context)) {
    throw params.error;
  }
  params.ctx.runtime.error?.(
    danger(`slack ${params.label} handler failed: ${formatErrorMessage(params.error)}`),
  );
}

export async function authorizeAndResolveSlackSystemEventContext(params: {
  ctx: SlackMonitorContext;
  senderId?: string;
  channelId?: string;
  channelType?: string | null;
  eventKind: string;
}): Promise<SlackAuthorizedSystemEventContext | undefined> {
  const { ctx, senderId, channelId, channelType, eventKind } = params;
  const auth = await authorizeSlackSystemEventSender({
    ctx,
    senderId,
    channelId,
    channelType,
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
  const sessionKey = ctx.resolveSlackSystemEventSessionKey({
    channelId,
    channelType: auth.channelType,
    senderId,
  });
  return {
    channelLabel,
    sessionKey,
  };
}
