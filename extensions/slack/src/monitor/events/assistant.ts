import type { Block, KnownBlock } from "@slack/web-api";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { buildSlackAssistantThreadMetadata, DEFAULT_SLACK_SUGGESTED_PROMPTS } from "../context.js";
import type { SlackMonitorContext, SlackAssistantThreadContext } from "../context.js";

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

type SlackAssistantThreadEvent = {
  type: "assistant_thread_started" | "assistant_thread_context_changed";
  assistant_thread?: SlackAssistantThreadPayload;
  context?: SlackAssistantThreadContextPayload;
  event_ts?: string;
};

type SlackAssistantEventRegistrar = (
  name: SlackAssistantThreadEvent["type"],
  handler: (args: { event: SlackAssistantThreadEvent; body: unknown }) => Promise<void>,
) => void;

function normalizeAssistantThread(
  event: SlackAssistantThreadEvent,
  getPrevious?: (channelId: string, threadTs: string) => SlackAssistantThreadContext | undefined,
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
  const previous = getPrevious?.(channelId, threadTs);
  const threadContext = thread.context;
  const eventContext = event.context;
  const resolveContextString = (
    key: keyof Pick<SlackAssistantThreadContextPayload, "channel_id" | "team_id">,
    previousValue: string | undefined,
  ) => threadContext?.[key]?.trim() || eventContext?.[key]?.trim() || previousValue;
  const enterpriseId = (() => {
    if (threadContext && "enterprise_id" in threadContext) {
      return threadContext.enterprise_id === null
        ? null
        : threadContext.enterprise_id?.trim() || previous?.enterpriseId;
    }
    if (eventContext && "enterprise_id" in eventContext) {
      return eventContext.enterprise_id === null
        ? null
        : eventContext.enterprise_id?.trim() || previous?.enterpriseId;
    }
    return previous?.enterpriseId;
  })();
  return {
    assistantChannelId: channelId,
    threadTs,
    userId: thread.user_id?.trim() || previous?.userId,
    channelId: resolveContextString("channel_id", previous?.channelId),
    teamId: resolveContextString("team_id", previous?.teamId),
    enterpriseId,
  };
}

async function persistAssistantThreadMetadata(params: {
  ctx: SlackMonitorContext;
  assistantThread: Omit<SlackAssistantThreadContext, "updatedAt">;
}) {
  const { ctx, assistantThread } = params;
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

export function registerSlackAssistantEvents(params: {
  ctx: SlackMonitorContext;
  /** Called on each inbound event to update liveness tracking. */
  trackEvent?: () => void;
}) {
  const { ctx, trackEvent } = params;
  const slackApp = ctx.app as unknown as { event: SlackAssistantEventRegistrar };

  for (const eventName of [
    "assistant_thread_started",
    "assistant_thread_context_changed",
  ] as const) {
    slackApp.event(eventName, async ({ event, body }) => {
      if (ctx.shouldDropMismatchedSlackEvent(body)) {
        return;
      }
      trackEvent?.();
      const assistantThread = normalizeAssistantThread(event, ctx.getSlackAssistantThreadContext);
      if (!assistantThread) {
        logVerbose(`slack ${eventName} dropped: missing assistant thread channel/thread`);
        return;
      }
      ctx.saveSlackAssistantThreadContext(assistantThread);
      if (eventName === "assistant_thread_started") {
        await ctx.setSlackSuggestedPrompts({
          channelId: assistantThread.assistantChannelId,
          threadTs: assistantThread.threadTs,
          title: "Try asking",
          prompts: DEFAULT_SLACK_SUGGESTED_PROMPTS,
        });
      } else {
        await persistAssistantThreadMetadata({ ctx, assistantThread });
      }
    });
  }
}
