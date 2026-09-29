import type { AllMiddlewareArgs, SlackShortcutMiddlewareArgs } from "@slack/bolt";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { authorizeSlackSystemEventSender } from "../auth.js";
import type { SlackMonitorContext } from "../context.js";
import { resolveSlackDeferredActionTarget } from "../deferred-action-routing.js";
import { resolveSlackListenerEventScope } from "../event-scope.js";
import { enqueueSlackInteractionEvent } from "./interaction-event.js";

type SlackShortcutHandlerArgs = SlackShortcutMiddlewareArgs &
  Pick<AllMiddlewareArgs, "context" | "client">;

export function registerSlackShortcutHandler(params: {
  ctx: SlackMonitorContext;
  trackEvent?: () => void;
  formatSystemEvent: (payload: Record<string, unknown>) => string;
}): void {
  if (typeof params.ctx.app.shortcut !== "function") {
    return;
  }
  params.ctx.app.shortcut(/.+/, async (args: SlackShortcutHandlerArgs) => {
    const { ack, body } = args;
    await ack();
    const runtimeContext = await params.ctx.readRuntimeContext();
    const eventScope = resolveSlackListenerEventScope({
      identity: runtimeContext.installationIdentity,
      body,
      context: args.context,
      client: args.client,
      clientOptions: runtimeContext.app.webClientOptions,
      onDrop: (reason) => runtimeContext.runtime.log?.(`slack:interaction drop shortcut ${reason}`),
    });
    if (eventScope === null) {
      return;
    }
    if (runtimeContext.shouldDropMismatchedSlackEvent?.(body)) {
      runtimeContext.runtime.log?.("slack:interaction drop shortcut payload (mismatched app/team)");
      return;
    }

    const callbackId = body.callback_id?.trim();
    const userId = body.user?.id?.trim();
    if (!callbackId || !userId) {
      runtimeContext.runtime.log?.("slack:interaction drop shortcut reason=invalid-payload");
      return;
    }
    params.trackEvent?.();

    const isMessageShortcut = body.type === "message_action";
    const messageBody = isMessageShortcut ? body : undefined;
    const channelId = messageBody?.channel.id?.trim() || undefined;
    if (isMessageShortcut && !channelId) {
      runtimeContext.runtime.log?.(
        `slack:interaction drop shortcut callback=${callbackId} user=${userId} reason=missing-channel`,
      );
      return;
    }
    const threadTs = normalizeOptionalString(messageBody?.message.thread_ts);
    const auth = await authorizeSlackSystemEventSender({
      ctx: runtimeContext,
      eventScope,
      senderId: userId,
      channelId,
      channelType: isMessageShortcut ? undefined : "im",
      expectedSenderId: userId,
      interactiveEvent: true,
    });
    if (!auth.allowed) {
      runtimeContext.runtime.log?.(
        `slack:interaction drop shortcut callback=${callbackId} user=${userId} reason=${auth.reason ?? "unauthorized"}`,
      );
      return;
    }

    const interactionType = isMessageShortcut ? "message_shortcut" : "global_shortcut";
    const messageTs = messageBody?.message.ts || messageBody?.message_ts;
    const teamId = args.context.teamId;
    const deferredTarget = resolveSlackDeferredActionTarget({
      eventScope,
      kind: auth.channelType === "im" ? "user" : "channel",
      id: auth.channelType === "im" ? userId : (channelId ?? ""),
    });
    const eventPayload = {
      interactionType,
      actionId: `shortcut:${callbackId}`,
      callbackId,
      userId,
      teamId,
      triggerId: body.trigger_id,
      actionTs: body.action_ts,
      channelId,
      channelName: messageBody?.channel.name,
      messageTs,
      threadTs,
      messageUserId: messageBody?.message.user,
      messageText: messageBody?.message.text,
      responseUrl: messageBody?.response_url,
    };
    const route = runtimeContext.resolveSlackSystemEventRoute({
      channelId,
      channelType: auth.channelType,
      senderId: userId,
      threadTs,
      eventScope,
    });
    const contextKey = [
      "slack:interaction:shortcut",
      interactionType,
      teamId,
      callbackId,
      channelId,
      messageTs,
      body.action_ts,
    ]
      .filter(Boolean)
      .join(":");

    runtimeContext.runtime.log?.(
      `slack:interaction ${interactionType} callback=${callbackId} user=${userId} channel=${channelId ?? "direct"}`,
    );
    enqueueSlackInteractionEvent(params.formatSystemEvent(eventPayload), route, {
      contextKey,
      deliveryContext: {
        channel: "slack",
        to: deferredTarget.target,
        accountId: runtimeContext.accountId,
        threadId: threadTs,
      },
    });
  });
}
