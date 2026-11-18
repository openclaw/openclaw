import type { AllMiddlewareArgs, SlackShortcutMiddlewareArgs } from "@slack/bolt";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { authorizeSlackSystemEventSender } from "../auth.js";
import type { SlackMonitorContext } from "../context.js";
import { resolveSlackDeferredActionTarget } from "../deferred-action-routing.js";
import { resolveSlackInteractionEventScope } from "../event-scope.js";
import {
  captureSlackInteractionEventRoute,
  enqueueSlackInteractionEvent,
} from "./interaction-event.js";
import { registerSlackBlockActionHandler } from "./interactions.block-actions.js";
import { registerModalLifecycleHandler } from "./interactions.modal.js";

type SlackShortcutHandlerArgs = SlackShortcutMiddlewareArgs &
  Pick<AllMiddlewareArgs, "context" | "client">;

export function registerSlackInteractionEvents(params: {
  ctx: SlackMonitorContext;
  trackEvent?: () => void;
}) {
  const { ctx, trackEvent } = params;
  registerSlackBlockActionHandler(params);
  params.ctx.app.shortcut(/.+/, async (args: SlackShortcutHandlerArgs) => {
    const { ack, body } = args;
    await ack();
    const runtimeContext = await params.ctx.readRuntimeContext();
    const eventScope = resolveSlackInteractionEventScope(runtimeContext, args, "shortcut");
    if (eventScope === null) {
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
    const destination = await runtimeContext.resolveSlackSystemEventRoute({
      channelId,
      channelType: auth.channelType,
      senderId: userId,
      threadTs,
      eventScope,
    });
    const route = await captureSlackInteractionEventRoute(destination, runtimeContext.runtime.log);
    if (!route || !runtimeContext.isRuntimePolicyCurrent()) {
      return;
    }
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
    await enqueueSlackInteractionEvent(
      eventPayload,
      route,
      {
        contextKey,
        deliveryContext: {
          channel: "slack",
          to: deferredTarget.target,
          accountId: runtimeContext.accountId,
          threadId: threadTs,
        },
      },
      runtimeContext.runtime.log,
    );
  });

  // Bolt routes both modal lifecycles through view constraints; there is no viewClosed API.
  for (const interactionType of ["view_submission", "view_closed"] as const) {
    registerModalLifecycleHandler({
      ctx,
      trackEvent,
      interactionType,
    });
  }
}
