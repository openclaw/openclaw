/**
 * Slack native text streaming helpers.
 *
 * Uses the Slack SDK's `ChatStreamer` (via `client.chatStream()`) to stream
 * text responses word-by-word in a single updating message, matching Slack's
 * "Agents & AI Apps" streaming UX.
 *
 * @see https://docs.slack.dev/ai/developing-ai-apps#streaming
 * @see https://docs.slack.dev/reference/methods/chat.startStream
 * @see https://docs.slack.dev/reference/methods/chat.appendStream
 * @see https://docs.slack.dev/reference/methods/chat.stopStream
 */

import type { WebClient } from "@slack/web-api";
import type { ChatStreamer } from "@slack/web-api/dist/chat-stream.js";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SlackStreamSession = {
  /** The SDK ChatStreamer instance managing this stream. */
  streamer: ChatStreamer;
  /** Channel this stream lives in. */
  channel: string;
  /** Thread timestamp (required for streaming). */
  threadTs: string;
  /** True once stop() has been called. */
  stopped: boolean;
};

export type StartSlackStreamParams = {
  client: WebClient;
  channel: string;
  threadTs: string;
  /** Optional initial markdown text to include in the stream start. */
  text?: string;
  /**
   * The team ID of the workspace this stream belongs to.
   * Required by the Slack API for `chat.startStream` / `chat.stopStream`.
   * Obtain from `auth.test` response (`team_id`).
   */
  teamId?: string;
  /**
   * The user ID of the message recipient (required for DM streaming).
   * Without this, `chat.stopStream` fails with `missing_recipient_user_id`
   * in direct message conversations.
   */
  userId?: string;
};

export type AppendSlackStreamParams = {
  session: SlackStreamSession;
  text: string;
};

export type AppendSlackStreamTaskParams = {
  session: SlackStreamSession;
  /** Stable identifier for this task (used to update the same card). */
  taskId: string;
  /** Display title shown on the task card. */
  title: string;
  /** "in_progress" while the task is running, "complete" when done. */
  status: "in_progress" | "complete";
};

export type StopSlackStreamParams = {
  session: SlackStreamSession;
  /** Optional final markdown text to append before stopping. */
  text?: string;
};

// ---------------------------------------------------------------------------
// Stream lifecycle
// ---------------------------------------------------------------------------

/**
 * Start a new Slack text stream.
 *
 * Returns a {@link SlackStreamSession} that should be passed to
 * {@link appendSlackStream} and {@link stopSlackStream}.
 *
 * The first chunk of text can optionally be included via `text`.
 */
export async function startSlackStream(
  params: StartSlackStreamParams,
): Promise<SlackStreamSession> {
  const { client, channel, threadTs, text, teamId, userId } = params;

  logVerbose(
    `slack-stream: starting stream in ${channel} thread=${threadTs}${teamId ? ` team=${teamId}` : ""}${userId ? ` user=${userId}` : ""}`,
  );

  const streamer = client.chatStream({
    channel,
    thread_ts: threadTs,
    ...(teamId ? { recipient_team_id: teamId } : {}),
    ...(userId ? { recipient_user_id: userId } : {}),
  });

  const session: SlackStreamSession = {
    streamer,
    channel,
    threadTs,
    stopped: false,
  };

  // If initial text is provided, send it as the first append which will
  // trigger the ChatStreamer to call chat.startStream under the hood.
  if (text) {
    await streamer.append({ markdown_text: text });
    logVerbose(`slack-stream: appended initial text (${text.length} chars)`);
  }

  return session;
}

/**
 * Append markdown text to an active Slack stream.
 */
export async function appendSlackStream(params: AppendSlackStreamParams): Promise<void> {
  const { session, text } = params;

  if (session.stopped) {
    logVerbose("slack-stream: attempted to append to a stopped stream, ignoring");
    return;
  }

  if (!text) {
    return;
  }

  await session.streamer.append({ markdown_text: text });
  logVerbose(`slack-stream: appended ${text.length} chars`);
}

/**
 * Append a task-update card to an active Slack stream.
 *
 * Task cards render as a collapsible "plan" item in the Slack UI, matching
 * the native Slack AI Apps streaming UX for showing tool progress.
 *
 * @see https://docs.slack.dev/ai/developing-ai-apps#streaming-tasks
 */
export async function appendSlackStreamTask(params: AppendSlackStreamTaskParams): Promise<void> {
  const { session, taskId, title, status } = params;

  if (session.stopped) {
    logVerbose("slack-stream: attempted to append task to a stopped stream, ignoring");
    return;
  }

  // The Slack SDK ChatStreamer.append() accepts task_update alongside markdown_text.
  // We cast to any since the SDK types don't expose the full union yet.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (session.streamer as any).append({
    type: "task_update",
    task_id: taskId,
    title,
    status,
  });
  logVerbose(`slack-stream: task_update taskId=${taskId} status=${status} title="${title}"`);
}

/**
 * Stop (finalize) a Slack stream.
 *
 * After calling this the stream message becomes a normal Slack message.
 * Optionally include final text to append before stopping.
 */
export async function stopSlackStream(params: StopSlackStreamParams): Promise<void> {
  const { session, text } = params;

  if (session.stopped) {
    logVerbose("slack-stream: stream already stopped, ignoring duplicate stop");
    return;
  }

  session.stopped = true;

  logVerbose(
    `slack-stream: stopping stream in ${session.channel} thread=${session.threadTs}${
      text ? ` (final text: ${text.length} chars)` : ""
    }`,
  );

  await session.streamer.stop(text ? { markdown_text: text } : undefined);

  logVerbose("slack-stream: stream stopped");
}
