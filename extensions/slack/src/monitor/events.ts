import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from "@slack/bolt";
import type { HomeView } from "@slack/types";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { normalizeStringEntriesLower } from "openclaw/plugin-sdk/string-normalization-runtime";
import { enqueueRoutedSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import { resolveSlackAccount } from "../accounts.js";
import { DEFAULT_SLACK_SUGGESTED_PROMPTS } from "../channel-meta.js";
import { getSlackRuntime } from "../runtime.js";
import { markSlackStreamsStopped } from "../streaming.js";
import { allowListMatches } from "./allow-list.js";
import { authorizeSlackSystemEventSender } from "./auth.js";
import { resolveSlackChatType } from "./channel-type.js";
import type { SlackMonitorContext } from "./context.js";
import { resolveSlackMonitorEventScope, type SlackEventScope } from "./event-scope.js";
import { registerSlackAssistantEvents } from "./events/assistant.js";
import {
  registerSlackChannelEvents,
  registerSlackChannelIdChangedEvent,
} from "./events/channels.js";
import { registerSlackInteractionEvents } from "./events/interactions.js";
import { registerSlackMemberEvents } from "./events/members.js";
import { registerSlackMessageEvents as registerSlackMessageEventHandlers } from "./events/messages.js";
import { authorizeAndResolveSlackSystemEventContext } from "./events/system-event-context.js";
import { resolveSlackIngressTurnLifecycle, resolveSlackSenderAuthentication } from "./ingress.js";
import type { SlackMessageHandler } from "./message-handler.js";
import { resolveSlackSessionEventRoutingContext } from "./message-handler/prepare-routing.js";
import { getSlackSessionRuns } from "./session-run-targets.js";
import { createSlackCommandHandler, deliverSlackSlashResponseWithWebApi } from "./slash.js";
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
    async ({
      event,
      body,
      context,
    }: SlackEventMiddlewareArgs<"app_home_opened"> & AllMiddlewareArgs) => {
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
          ...(resolveSlackIngressTurnLifecycle(context) ? { retryTransientErrors: true } : {}),
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
  const account = resolveSlackAccount({ cfg: ctx.cfg, accountId: ctx.accountId });
  const handleCommand = createSlackCommandHandler({ ctx, account, trackEvent });

  ctx.app.event("app_context_changed", async ({ body }) => {
    if (ctx.shouldDropMismatchedSlackEvent(body)) {
      return;
    }
    trackEvent?.();
    await ctx.recordSlackAgentView();
  });

  ctx.app.event("agent_session_stopped", async ({ event, body, context, client }) => {
    if (ctx.shouldDropMismatchedSlackEvent(body)) {
      return;
    }
    const eventScope = resolveSlackMonitorEventScope({ ctx, body, context, client });
    if (eventScope === null) {
      return;
    }
    const slackClient = eventScope?.client ?? ctx.app.client;
    const command = {
      user_id: event.user,
      user_name: event.user,
      channel_id: event.channel,
      channel_name: event.channel,
    };
    const address = { channelId: event.channel, threadTs: event.thread_ts, eventScope };
    const targets = getSlackSessionRuns(ctx, address);
    const responses: Parameters<typeof deliverSlackSlashResponseWithWebApi>[0]["message"][] = [];
    // One visible Slack thread can have overlapping flat-root and reply sessions.
    // Hold confirmations until every current publisher has passed normal Stop admission.
    const results = [];
    for (const target of targets.length > 0 ? targets : [undefined]) {
      results.push(
        await handleCommand({
          command,
          ack: async () => {},
          respond: async (message) => {
            responses.push(message);
          },
          responseTransport: "web-api",
          body,
          eventScope,
          senderAuthentication: resolveSlackSenderAuthentication(context),
          prompt: "/stop",
          builtInCommand: "stop",
          sessionTarget: target?.route,
          isSessionTargetCurrent: target?.isActive,
          onAdmitted: () => {
            if (target && !target.isActive()) {
              return false;
            }
            // Mark before abort cleanup, but only after authorization: denied Stops must
            // leave fallback delivery available for streams Slack already halted.
            markSlackStreamsStopped(slackClient, event.channel, event.streaming_message_ts);
            return true;
          },
          threadTs: event.thread_ts,
          eventTs: event.event_ts,
        }),
      );
    }
    for (const message of responses) {
      await deliverSlackSlashResponseWithWebApi({
        client: slackClient,
        command,
        threadTs: event.thread_ts,
        message,
      });
    }
    if (!results.every(Boolean) || getSlackSessionRuns(ctx, address).length > 0) {
      return;
    }
    // Recover stale processing only after every owning run completed Stop dispatch.
    await ctx.setSlackSessionStatus({
      channelId: event.channel,
      threadTs: event.thread_ts,
      status: "active",
      eventScope,
    });
  });

  ctx.app.event("agent_session_title_changed", async ({ event, body, context, client }) => {
    const runtimeContext = await ctx.readRuntimeContext();
    const runtimeAccount = resolveSlackAccount({
      cfg: runtimeContext.cfg,
      accountId: runtimeContext.accountId,
    });
    if (runtimeContext.shouldDropMismatchedSlackEvent(body)) {
      return;
    }
    const eventScope = resolveSlackMonitorEventScope({
      ctx: runtimeContext,
      body,
      context,
      client,
    });
    if (eventScope === null) {
      return;
    }
    trackEvent?.();
    try {
      const auth = await authorizeSlackSystemEventSender({
        ctx: runtimeContext,
        senderId: event.user,
        channelId: event.channel,
        eventScope,
      });
      if (!auth.allowed) {
        return;
      }
      const routing = await resolveSlackSessionEventRoutingContext({
        intent: "title",
        ctx: runtimeContext,
        account: runtimeAccount,
        message: {
          type: "message",
          channel: event.channel,
          user: event.user,
          ts: event.event_ts,
          thread_ts: event.thread_ts,
        },
        chatType: resolveSlackChatType(auth.channelType),
        eventScope,
      });
      try {
        const updated = await getSlackRuntime().agent.session.prepareSessionEntryPatch({
          agentId: routing.route.agentId,
          storePath: resolveStorePath(runtimeContext.cfg.session?.store, {
            agentId: routing.route.agentId,
          }),
          sessionKey: routing.sessionKey,
          preserveActivity: true,
          authority: { kind: "source", source: routing.sessionSource },
          prepare: () => ({ displayName: event.title }),
        });
        if (!updated) {
          throw new Error("Slack conversation session disappeared before the title update");
        }
        runtimeContext.recordSlackSessionTitle({
          channelId: event.channel,
          threadTs: event.thread_ts,
          title: event.title,
          eventScope,
        });
      } finally {
        routing.release();
      }
    } catch (error) {
      runtimeContext.runtime.error?.(
        `slack session title update failed: ${formatErrorMessage(error)}`,
      );
    }
  });
  registerSlackAssistantEvents({ ctx, trackEvent });
}
