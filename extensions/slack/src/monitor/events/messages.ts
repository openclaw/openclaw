import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from "@slack/bolt";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  createSubsystemLogger,
  danger,
  logVerbose,
  shouldLogVerbose,
} from "openclaw/plugin-sdk/runtime-env";
import {
  asOptionalRecord as asRecord,
  normalizeOptionalString as asString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { enqueueRoutedSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import { noteSlackDraftConversationMessage } from "../../draft-message-boundaries.js";
import type { SlackAppMentionEvent, SlackMessageEvent } from "../../types.js";
import { normalizeSlackChannelType } from "../channel-type.js";
import type { SlackMonitorContext } from "../context.js";
import { resolveSlackMonitorEventScope, type SlackEventScope } from "../event-scope.js";
import { resolveSlackIngressTurnLifecycle, resolveSlackSenderAuthentication } from "../ingress.js";
import type { SlackMessageHandler } from "../message-handler.js";
import type { SlackMessageChangedEvent } from "../types.js";
import { resolveSlackMessageSubtypeHandler } from "./message-subtype-handlers.js";
import { authorizeAndResolveSlackSystemEventContext } from "./system-event-context.js";

// Mirrors the Telegram `[telegram]` inbound logger so cross-channel journal-grep
// workflows are uniform; the `gateway/channels/slack` subsystem renders as `[slack]`.
const slackInboundLog = createSubsystemLogger("gateway/channels/slack").child("inbound");

function isBotAuthoredEnterpriseEvent(event: { bot_id?: unknown; subtype?: unknown }): boolean {
  return Boolean(asString(event.bot_id)) || event.subtype === "bot_message";
}

async function resolveSlackAppMentionChannelType(params: {
  ctx: SlackMonitorContext;
  eventScope?: SlackEventScope;
  mention: SlackAppMentionEvent;
}): Promise<{
  type: SlackMessageEvent["channel_type"] | undefined;
  lookupFailureCategory?: Awaited<
    ReturnType<SlackMonitorContext["resolveChannelName"]>
  >["lookupFailureCategory"];
}> {
  const explicitType = asString(params.mention.channel_type);
  if (explicitType) {
    return { type: normalizeSlackChannelType(explicitType, params.mention.channel) };
  }
  const rememberedType = params.ctx.recallSlackChannelType(
    params.mention.channel,
    params.eventScope,
  );
  if (rememberedType) {
    return { type: normalizeSlackChannelType(rememberedType, params.mention.channel) };
  }
  // app_mention omits channel_type, and Slack ID prefixes are not a type contract.
  // Only an authoritative event/cache/API type may choose this event's owner.
  const resolved = await params.ctx
    .resolveChannelName(params.mention.channel, params.eventScope)
    .catch(() => ({ type: undefined, lookupFailureCategory: "other" as const }));
  return {
    type: resolved.type
      ? normalizeSlackChannelType(resolved.type, params.mention.channel)
      : undefined,
    lookupFailureCategory: resolved.lookupFailureCategory,
  };
}

function resolveAssistantMessageChangedSender(params: {
  message?: Record<string, unknown>;
  botUserId: string;
}): string | undefined {
  const payload = asRecord(asRecord(params.message?.metadata)?.event_payload);
  if (!payload) {
    return undefined;
  }
  const candidates = new Set<string>();
  for (const key of ["user", "user_id", "actor_user_id", "author_user_id", "slack_user_id"]) {
    const id = asString(payload[key]);
    if (id && id !== params.botUserId && /^[UW][A-Z0-9]+$/.test(id)) {
      candidates.add(id);
    }
  }
  return candidates.size === 1 ? [...candidates][0] : undefined;
}

function isSelfAttributedMessageChange(params: {
  event: SlackMessageChangedEvent;
  message?: Record<string, unknown>;
  ctx: SlackMonitorContext;
}): boolean {
  const topUser = asString((params.event as SlackMessageChangedEvent & { user?: unknown }).user);
  const messageUser = asString(params.message?.user);
  const messageBotId = asString(params.message?.bot_id);
  return (
    (Boolean(params.ctx.botUserId) &&
      (topUser === params.ctx.botUserId || messageUser === params.ctx.botUserId)) ||
    (Boolean(params.ctx.botId) && messageBotId === params.ctx.botId)
  );
}

function resolveAssistantMessageChangedInbound(params: {
  event: SlackMessageEvent;
  ctx: SlackMonitorContext;
}): SlackMessageEvent | undefined {
  if (params.event.subtype !== "message_changed") {
    return undefined;
  }
  const changed = params.event as SlackMessageChangedEvent;
  const message = asRecord(changed.message);
  if (!message || !isSelfAttributedMessageChange({ event: changed, message, ctx: params.ctx })) {
    return undefined;
  }
  const channelType = normalizeSlackChannelType(
    asString((changed as SlackMessageChangedEvent & { channel_type?: unknown }).channel_type),
    changed.channel,
  );
  if (channelType !== "im") {
    return undefined;
  }
  const senderId = resolveAssistantMessageChangedSender({
    message,
    botUserId: params.ctx.botUserId,
  });
  if (!senderId) {
    if (shouldLogVerbose()) {
      logVerbose(
        `slack: assistant_app_thread message_changed in DM channel=${changed.channel} dropped: no sender resolved from metadata`,
      );
    }
    return undefined;
  }
  return {
    type: "message",
    channel: changed.channel ?? params.event.channel,
    channel_type: "im",
    user: senderId,
    text: asString(message.text),
    ts: asString(message.ts) ?? asString(changed.event_ts),
    thread_ts: asString(message.thread_ts),
    event_ts: changed.event_ts,
    assistant_thread:
      asRecord(message.assistant_thread) ??
      asRecord(
        (changed as SlackMessageChangedEvent & { assistant_thread?: unknown }).assistant_thread,
      ),
    files: Array.isArray(message.files) ? (message.files as SlackMessageEvent["files"]) : undefined,
    attachments: Array.isArray(message.attachments)
      ? (message.attachments as SlackMessageEvent["attachments"])
      : undefined,
    blocks: Array.isArray(message.blocks)
      ? (message.blocks as SlackMessageEvent["blocks"])
      : undefined,
  };
}

export function registerSlackMessageEvents(params: {
  ctx: SlackMonitorContext;
  handleSlackMessage: SlackMessageHandler;
}) {
  const { ctx, handleSlackMessage } = params;

  const noteConversationMessage = (
    message: SlackMessageEvent | SlackAppMentionEvent,
    eventScope?: SlackEventScope,
  ) => {
    noteSlackDraftConversationMessage({
      accountId: ctx.accountId,
      teamId: eventScope?.teamId,
      channelId: message.channel,
      threadTs: message.thread_ts,
      messageTs: message.ts ?? message.event_ts,
      userId: asString(message.user),
      botUserId: ctx.botUserId,
      botId: asString(message.bot_id),
      subtype: "subtype" in message ? asString(message.subtype) : undefined,
    });
  };

  // Slack subscription names such as message.channels still deliver the message event.
  for (const source of ["message", "app_mention"] as const) {
    ctx.app.event(
      source,
      async ({
        event,
        body,
        context,
        client,
      }: SlackEventMiddlewareArgs<typeof source> & AllMiddlewareArgs) => {
        const turnAdoptionLifecycle = resolveSlackIngressTurnLifecycle(context);
        try {
          const eventScope = resolveSlackMonitorEventScope({
            ctx,
            body,
            context,
            client,
            onDrop: (reason) => logVerbose(`slack: drop event (${reason})`),
          });
          if (eventScope === null || ctx.shouldDropMismatchedSlackEvent(body)) {
            return;
          }
          const message = event as SlackMessageEvent;
          let assistantChangedInbound: SlackMessageEvent | undefined;
          if (source === "message") {
            // Subtype handlers do not enter the regular message pipeline. Observe any explicit
            // type here so edits and deletes share the same authoritative conversation cache.
            ctx.rememberSlackChannelType(message.channel, message.channel_type, eventScope);
            assistantChangedInbound = resolveAssistantMessageChangedInbound({
              event: message,
              ctx,
            });
            if (
              !assistantChangedInbound &&
              message.subtype === "message_changed" &&
              isSelfAttributedMessageChange({
                event: message as SlackMessageChangedEvent,
                message: asRecord((message as SlackMessageChangedEvent).message),
                ctx,
              })
            ) {
              return;
            }

            const subtypeHandler = assistantChangedInbound
              ? undefined
              : resolveSlackMessageSubtypeHandler(message);
            if (subtypeHandler) {
              const ingressContext = await authorizeAndResolveSlackSystemEventContext({
                ctx,
                senderId: subtypeHandler.senderId,
                channelId: message.channel,
                threadTs: subtypeHandler.threadTs,
                eventKind: subtypeHandler.eventKind,
                eventScope,
              });
              if (!ingressContext) {
                return;
              }
              enqueueRoutedSystemEvent(
                subtypeHandler.describe(ingressContext.channelLabel),
                ingressContext.route,
                {
                  contextKey: `${subtypeHandler.contextKey}:${body.event_id}`,
                },
              );
              return;
            }
          } else {
            const mention = event as SlackAppMentionEvent;
            if (eventScope && isBotAuthoredEnterpriseEvent(mention)) {
              logVerbose("slack: drop enterprise bot-authored app_mention");
              return;
            }

            // DM and MPIM messages are owned by message.im/message.mpim. Resolve the
            // omitted type before this guard so event ordering cannot change ownership.
            const { type: channelType, lookupFailureCategory } =
              await resolveSlackAppMentionChannelType({
                ctx,
                mention,
                eventScope,
              });
            if (!channelType) {
              // OpenClaw manifests pair app_mention with message.channels/groups/im/mpim.
              // Never guess here: the canonical message event still owns delivery.
              const channelId = /^[CDG][A-Z0-9]{1,32}$/.test(mention.channel)
                ? mention.channel
                : "unrecognized";
              const category = lookupFailureCategory ?? "missing_type";
              slackInboundLog.info(
                `Slack app_mention skipped: conversation type unresolved; channelId=${channelId} lookupFailureCategory=${category}; waiting for message event`,
                { channelId, lookupFailureCategory: category },
              );
              return;
            }
            if (channelType === "im" || channelType === "mpim") {
              return;
            }

            // Emit a per-inbound receipt before dispatch so a silently-dropped mention
            // (e.g. router consumes it without a tool call) still leaves journal evidence,
            // matching the Telegram inbound log. Runs after the DM drop above, so duplicate
            // DM app_mention events (already handled via message.im) produce no line.
            const from = `slack:${eventScope?.teamId ?? ctx.teamId}:channel:${mention.channel}:user:${asString(mention.user) ?? "unknown"}`;
            slackInboundLog.info(
              `Inbound app_mention ${from} -> bot:${ctx.botUserId} (${channelType}, ${asString(mention.text)?.length ?? 0} chars)`,
            );
          }
          const inbound = assistantChangedInbound ?? message;
          noteConversationMessage(inbound, eventScope);
          await handleSlackMessage(inbound, {
            source,
            // Assistant metadata identifies an asserted sender, not Slack's event actor.
            senderAuthentication: assistantChangedInbound
              ? undefined
              : resolveSlackSenderAuthentication(context),
            ...(source === "app_mention" ? { wasMentioned: true } : {}),
            eventScope,
            ...(turnAdoptionLifecycle ? { turnAdoptionLifecycle } : {}),
            ...(eventScope || turnAdoptionLifecycle ? { awaitDispatch: true } : {}),
          });
        } catch (err) {
          if (turnAdoptionLifecycle) {
            throw err;
          }
          const handler = source === "app_mention" ? "mention handler" : "handler";
          ctx.runtime.error?.(danger(`slack ${handler} failed: ${formatErrorMessage(err)}`));
        }
      },
    );
  }
}
