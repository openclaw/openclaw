import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { SlackMonitorContext, SlackAssistantSuggestedPrompt } from "../context.js";

type SlackAssistantThreadPayload = {
  user_id?: string;
  context?: SlackAssistantThreadContextPayload;
  channel_id?: string;
  thread_ts?: string;
};

type SlackAssistantThreadContextPayload = {
  channel_id?: string;
  team_id?: string;
  enterprise_id?: string | null;
};

type SlackAssistantThreadStartedEvent = {
  type: "assistant_thread_started";
  assistant_thread?: SlackAssistantThreadPayload;
  context?: SlackAssistantThreadContextPayload;
  event_ts?: string;
};

type SlackAssistantThreadContextChangedEvent = {
  type: "assistant_thread_context_changed";
  assistant_thread?: SlackAssistantThreadPayload;
  context?: SlackAssistantThreadContextPayload;
  event_ts?: string;
};

type SlackAssistantEventHandler<TEvent> = (args: { event: TEvent; body: unknown }) => Promise<void>;

type SlackAssistantEventRegistrar = {
  (
    name: "assistant_thread_started",
    handler: SlackAssistantEventHandler<SlackAssistantThreadStartedEvent>,
  ): void;
  (
    name: "assistant_thread_context_changed",
    handler: SlackAssistantEventHandler<SlackAssistantThreadContextChangedEvent>,
  ): void;
};

const DEFAULT_ASSISTANT_PROMPTS: SlackAssistantSuggestedPrompt[] = [
  { title: "What can you do?", message: "What can you help me with?" },
  { title: "Summarize this channel", message: "Summarize the recent activity in this channel." },
  { title: "Draft a reply", message: "Help me draft a reply." },
];

function normalizeAssistantThread(
  event: SlackAssistantThreadStartedEvent | SlackAssistantThreadContextChangedEvent,
) {
  const thread = event.assistant_thread;
  if (!thread) {
    return null;
  }
  const channelId = thread.channel_id?.trim();
  const threadTs = thread.thread_ts?.trim();
  if (!channelId || !threadTs) {
    return null;
  }
  return {
    assistantChannelId: channelId,
    threadTs,
    userId: thread.user_id?.trim() || undefined,
    channelId: (thread.context ?? event.context)?.channel_id?.trim() || undefined,
    teamId: (thread.context ?? event.context)?.team_id?.trim() || undefined,
    enterpriseId: (thread.context ?? event.context)?.enterprise_id ?? undefined,
  };
}

export function registerSlackAssistantEvents(params: {
  ctx: SlackMonitorContext;
  /** Called on each inbound event to update liveness tracking. */
  trackEvent?: () => void;
}) {
  const { ctx, trackEvent } = params;
  const slackApp = ctx.app as unknown as { event: SlackAssistantEventRegistrar };

  slackApp.event("assistant_thread_started", async ({ event, body }) => {
    try {
      if (ctx.shouldDropMismatchedSlackEvent(body)) {
        return;
      }
      trackEvent?.();
      const assistantThread = normalizeAssistantThread(event);
      if (!assistantThread) {
        logVerbose(
          "slack assistant_thread_started dropped: missing assistant thread channel/thread",
        );
        return;
      }
      ctx.saveSlackAssistantThreadContext(assistantThread);
      await ctx.setSlackAssistantSuggestedPrompts({
        channelId: assistantThread.assistantChannelId,
        threadTs: assistantThread.threadTs,
        title: "Try asking",
        prompts: DEFAULT_ASSISTANT_PROMPTS,
      });
    } catch (err) {
      ctx.runtime.error?.(
        danger(`slack assistant_thread_started handler failed: ${formatErrorMessage(err)}`),
      );
    }
  });

  slackApp.event("assistant_thread_context_changed", async ({ event, body }) => {
    try {
      if (ctx.shouldDropMismatchedSlackEvent(body)) {
        return;
      }
      trackEvent?.();
      const assistantThread = normalizeAssistantThread(event);
      if (!assistantThread) {
        logVerbose(
          "slack assistant_thread_context_changed dropped: missing assistant thread channel/thread",
        );
        return;
      }
      ctx.saveSlackAssistantThreadContext(assistantThread);
    } catch (err) {
      ctx.runtime.error?.(
        danger(`slack assistant_thread_context_changed handler failed: ${formatErrorMessage(err)}`),
      );
    }
  });
}
