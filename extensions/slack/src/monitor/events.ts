import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from "@slack/bolt";
import type { HomeView } from "@slack/types";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import { normalizeStringEntriesLower } from "openclaw/plugin-sdk/string-normalization-runtime";
import { enqueueRoutedSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import { DEFAULT_SLACK_SUGGESTED_PROMPTS } from "../channel-meta.js";
import { allowListMatches } from "./allow-list.js";
import type { SlackMonitorContext } from "./context.js";
import { resolveSlackMonitorEventScope, type SlackEventScope } from "./event-scope.js";
import { registerSlackAgentEvents } from "./events/agent.js";
import { registerSlackAssistantEvents } from "./events/assistant.js";
import {
  registerSlackChannelEvents,
  registerSlackChannelIdChangedEvent,
} from "./events/channels.js";
import { registerSlackInteractionEvents } from "./events/interactions.js";
import { registerSlackMemberEvents } from "./events/members.js";
import { registerSlackMessageEvents as registerSlackMessageEventHandlers } from "./events/messages.js";
import { authorizeAndResolveSlackSystemEventContext } from "./events/system-event-context.js";
import type { SlackMessageHandler } from "./message-handler.js";
import type { SlackPinEvent, SlackReactionEvent } from "./types.js";

function buildSlackHomeView(slashCommandName?: string): HomeView {
  const startSessionText = slashCommandName
    ? `Send a DM, mention OpenClaw in a channel, or use \`/${slashCommandName}\` to start a session.`
    : "Send a DM or mention OpenClaw in a channel to start a session.";
  return {
    type: "home",
    callback_id: "openclaw:home",
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "OpenClaw",
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: startSessionText,
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "This Home tab is safe to show to any workspace member who opens the app.",
          },
        ],
      },
    ],
  };
}

export function registerSlackCommonEvents(params: {
  ctx: SlackMonitorContext;
  handleSlackMessage: SlackMessageHandler;
  /** Called on each inbound event to update liveness tracking. */
  trackEvent?: () => void;
}) {
  const { ctx, trackEvent } = params;
  registerSlackMessageEventHandlers({
    ctx,
    handleSlackMessage: params.handleSlackMessage,
  });
  {
    const resolveUserName = (userId: string, eventScope?: SlackEventScope) =>
      eventScope ? ctx.resolveUserName(userId, eventScope) : ctx.resolveUserName(userId);

    for (const action of ["added", "removed"] as const) {
      ctx.app.event(
        `reaction_${action}`,
        async (
          args: SlackEventMiddlewareArgs<"reaction_added" | "reaction_removed"> & AllMiddlewareArgs,
        ) => {
          const { body, context, client } = args;
          const event: SlackReactionEvent = args.event;
          const eventScope = resolveSlackMonitorEventScope({ ctx, body, context, client });
          if (eventScope === null || ctx.shouldDropMismatchedSlackEvent(body)) {
            return;
          }
          const eventId = body.event_id;
          try {
            const runtimeContext = await params.ctx.readRuntimeContext();
            const item = event.item;
            if (!item || item.type !== "message") {
              return;
            }
            if (runtimeContext.reactionMode === "off") {
              return;
            }
            if (
              runtimeContext.reactionMode === "own" &&
              (!runtimeContext.botUserId || event.item_user !== runtimeContext.botUserId)
            ) {
              return;
            }
            trackEvent?.();

            const ingressContext = await authorizeAndResolveSlackSystemEventContext({
              ctx: runtimeContext,
              senderId: event.user,
              channelId: item.channel,
              eventKind: "reaction",
              eventScope,
            });
            if (!ingressContext) {
              return;
            }

            const [actorInfo, authorInfo] = await Promise.all(
              [event.user, event.item_user].map((userId) =>
                userId ? resolveUserName(userId, eventScope) : Promise.resolve(undefined),
              ),
            );
            if (runtimeContext.reactionMode === "allowlist") {
              const allowList = normalizeStringEntriesLower(runtimeContext.reactionAllowlist);
              if (
                allowList.length === 0 ||
                !allowListMatches({
                  allowList,
                  teamId: eventScope?.teamId ?? runtimeContext.teamId,
                  id: event.user,
                  name: actorInfo?.name,
                  allowNameMatching: runtimeContext.allowNameMatching,
                })
              ) {
                return;
              }
            }
            const actorLabel = actorInfo?.name ?? event.user;
            const emojiLabel = event.reaction ?? "emoji";
            const authorLabel = authorInfo?.name ?? event.item_user;
            const baseText = `Slack reaction ${action}: :${emojiLabel}: by ${actorLabel} in ${ingressContext.channelLabel} msg ${item.ts}`;
            const text = authorLabel ? `${baseText} from ${authorLabel}` : baseText;
            enqueueRoutedSystemEvent(text, ingressContext.route, {
              contextKey: `slack:reaction:${eventScope ? `${eventScope.teamId}:` : ""}${action}:${item.channel}:${item.ts}:${event.user}:${emojiLabel}:${eventId}`,
            });
          } catch (err) {
            ctx.runtime.error?.(
              danger(`slack reaction handler failed: ${formatErrorMessage(err)}`),
            );
          }
        },
      );
    }
  }
  {
    for (const contextKeySuffix of ["added", "removed"] as const) {
      const action = contextKeySuffix === "added" ? "pinned" : "unpinned";
      ctx.app.event(
        `pin_${contextKeySuffix}`,
        async (args: SlackEventMiddlewareArgs<"pin_added" | "pin_removed"> & AllMiddlewareArgs) => {
          const { event, body, context, client } = args;
          try {
            const eventScope = resolveSlackMonitorEventScope({ ctx, body, context, client });
            if (eventScope === null) {
              return;
            }
            if (ctx.shouldDropMismatchedSlackEvent(body)) {
              return;
            }
            trackEvent?.();

            const payload: SlackPinEvent = event;
            const channelId = payload.channel_id;
            const ingressContext = await authorizeAndResolveSlackSystemEventContext({
              ctx,
              senderId: payload.user,
              channelId,
              eventKind: "pin",
              eventScope,
            });
            if (!ingressContext) {
              return;
            }
            const userInfo = payload.user
              ? await (eventScope
                  ? ctx.resolveUserName(payload.user, eventScope)
                  : ctx.resolveUserName(payload.user))
              : {};
            const userLabel = userInfo?.name ?? payload.user ?? "someone";
            const itemType = payload.item?.type ?? "item";
            const messageId = payload.item?.message?.ts ?? payload.event_ts;
            enqueueRoutedSystemEvent(
              `Slack: ${userLabel} ${action} a ${itemType} in ${ingressContext.channelLabel}.`,
              ingressContext.route,
              {
                contextKey: `slack:pin:${eventScope ? `${eventScope.teamId}:` : ""}${contextKeySuffix}:${channelId ?? "unknown"}:${messageId ?? "unknown"}:${body.event_id}`,
              },
            );
          } catch (err) {
            ctx.runtime.error?.(
              danger(`slack pin ${contextKeySuffix} handler failed: ${formatErrorMessage(err)}`),
            );
          }
        },
      );
    }
  }
  registerSlackMemberEvents({ ctx, trackEvent });
  registerSlackChannelEvents({ ctx, trackEvent });
  registerSlackInteractionEvents({ ctx, trackEvent });
}

export function registerSlackWorkspaceEvents(params: {
  ctx: SlackMonitorContext;
  appHomeSlashCommandName?: string;
  /** Called on each inbound event to update liveness tracking. */
  trackEvent?: () => void;
}) {
  const { ctx, trackEvent } = params;
  const slashCommandName = params.appHomeSlashCommandName;
  registerSlackChannelIdChangedEvent({ ctx, trackEvent });
  ctx.app.event(
    "app_home_opened",
    async ({ event, body }: SlackEventMiddlewareArgs<"app_home_opened">) => {
      if (ctx.shouldDropMismatchedSlackEvent(body)) {
        return;
      }
      trackEvent?.();

      const payload = event;
      if (!payload.user) {
        return;
      }
      if (payload.tab === "messages") {
        if (!payload.channel) {
          return;
        }
        const outcome = await ctx.setSlackSuggestedPrompts({
          channelId: payload.channel,
          title: "Try asking",
          prompts: DEFAULT_SLACK_SUGGESTED_PROMPTS,
        });
        // Slack gates threadless calls before work: non-Agent apps get not_agent_app/missing_scope.
        // Thus internal_error also proves Agent View; transport failures stay inconclusive
        // so a network blip cannot durably mark a plain bot as Agent View.
        if (outcome === "accepted" || outcome === "internal_error") {
          await ctx.recordSlackAgentView();
        }
        return;
      }

      await ctx.app.client.views.publish({
        token: ctx.botToken,
        user_id: payload.user,
        view: buildSlackHomeView(slashCommandName),
      });
    },
  );
  registerSlackAgentEvents({ ctx, trackEvent });
  registerSlackAssistantEvents({ ctx, trackEvent });
}
