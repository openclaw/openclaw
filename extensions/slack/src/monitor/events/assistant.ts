import type { AssistantThreadStartedEvent } from "@slack/types";
import type { Block, KnownBlock } from "@slack/web-api";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { DEFAULT_SLACK_SUGGESTED_PROMPTS } from "../../channel-meta.js";
import { buildSlackAssistantThreadMetadata } from "../context.js";
import type { SlackMonitorContext } from "../context.js";
import { resolveSlackIngressTurnLifecycle } from "../ingress.js";

type SlackAssistantThreadContextPayload =
  AssistantThreadStartedEvent["assistant_thread"]["context"];

export function registerSlackAssistantEvents(params: {
  ctx: SlackMonitorContext;
  /** Called on each inbound event to update liveness tracking. */
  trackEvent?: () => void;
}) {
  const { ctx, trackEvent } = params;

  for (const eventName of [
    "assistant_thread_started",
    "assistant_thread_context_changed",
  ] as const) {
    ctx.app.event(eventName, async ({ event, body, context }) => {
      if (ctx.shouldDropMismatchedSlackEvent(body)) {
        return;
      }
      trackEvent?.();
      const getPrevious = ctx.getSlackAssistantThreadContext;
      const assistantEvent: typeof event & { context?: SlackAssistantThreadContextPayload } = event;
      const thread = assistantEvent.assistant_thread;
      if (!thread) {
        logVerbose(`slack ${eventName} dropped: missing assistant thread channel/thread`);
        return;
      }
      const channelId = thread.channel_id?.trim();
      const threadTs = thread.thread_ts?.trim();
      if (!channelId || !threadTs) {
        logVerbose(`slack ${eventName} dropped: missing assistant thread channel/thread`);
        return;
      }
      const previous = getPrevious?.(channelId, threadTs);
      const threadContext = thread.context;
      const eventContext = assistantEvent.context;
      const resolveContextString = (
        key: keyof Pick<SlackAssistantThreadContextPayload, "channel_id" | "team_id">,
        previousValue: string | undefined,
      ) => threadContext?.[key]?.trim() || eventContext?.[key]?.trim() || previousValue;
      const enterpriseContext =
        threadContext && "enterprise_id" in threadContext ? threadContext : eventContext;
      const assistantThread = {
        assistantChannelId: channelId,
        threadTs,
        channelId: resolveContextString("channel_id", previous?.channelId),
        teamId: resolveContextString("team_id", previous?.teamId),
        enterpriseId:
          enterpriseContext?.enterprise_id === null
            ? null
            : enterpriseContext?.enterprise_id?.trim() || previous?.enterpriseId,
      };
      ctx.saveSlackAssistantThreadContext(assistantThread);
      if (eventName === "assistant_thread_started") {
        await ctx.setSlackSuggestedPrompts({
          ...(resolveSlackIngressTurnLifecycle(context) ? { retryTransientErrors: true } : {}),
          channelId: assistantThread.assistantChannelId,
          threadTs: assistantThread.threadTs,
          title: "Try asking",
          prompts: DEFAULT_SLACK_SUGGESTED_PROMPTS,
        });
      } else {
        const response = (await ctx.app.client.conversations.replies({
          token: ctx.botToken,
          channel: assistantThread.assistantChannelId,
          ts: assistantThread.threadTs,
          include_all_metadata: true,
          limit: 4,
        })) as {
          messages?: Array<{
            subtype?: string;
            user?: string;
            ts?: string;
            text?: string;
            blocks?: (Block | KnownBlock)[];
          }>;
        };
        const initialMessage = (response.messages ?? []).find(
          (message) => !message.subtype && message.user === ctx.botUserId && message.ts,
        );
        if (!initialMessage?.ts) {
          return;
        }
        await ctx.app.client.chat.update({
          token: ctx.botToken,
          channel: assistantThread.assistantChannelId,
          ts: initialMessage.ts,
          text: initialMessage.text ?? "",
          blocks: Array.isArray(initialMessage.blocks) ? initialMessage.blocks : [],
          metadata: buildSlackAssistantThreadMetadata(assistantThread),
        });
      }
    });
  }
}
