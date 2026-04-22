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
 * Stop (finalize) a Slack stream.
 *
 * After calling this the stream message becomes a normal Slack message.
 * Optionally include final text to append before stopping.
 *
 * If Slack's `chat.stopStream` responds with a known benign finalize error
 * (e.g. `user_not_found` for Slack Connect recipients - see issue #70295),
 * any text already delivered via `append()` stays visible and the session
 * is marked stopped. Other Slack API errors still propagate so the caller
 * can record them.
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

  try {
    await session.streamer.stop(text ? { markdown_text: text } : undefined);
  } catch (err) {
    if (isBenignSlackFinalizeError(err)) {
      logVerbose(
        `slack-stream: finalize rejected by Slack (${formatSlackError(err)}); ` +
          "appended text remains visible, treating stream as stopped",
      );
      return;
    }
    throw err;
  }

  logVerbose("slack-stream: stream stopped");
}

// ---------------------------------------------------------------------------
// Finalize error classification
// ---------------------------------------------------------------------------

/**
 * Slack API error codes that indicate `chat.stopStream` cannot finalize the
 * stream for the current recipient/team, but any `chat.appendStream` calls
 * that already landed are still visible to the user. Treat these as benign
 * at the dispatch layer so the reply is not reported as an error when text
 * did get through.
 */
const BENIGN_SLACK_FINALIZE_ERROR_CODES = new Set<string>([
  // Slack Connect recipients: finalize fails because the external user id
  // is not resolvable in the host workspace (#70295).
  "user_not_found",
  // Slack Connect team mismatch in shared channels.
  "team_not_found",
  // DMs that closed between stream start and stop.
  "missing_recipient_user_id",
]);

function isBenignSlackFinalizeError(err: unknown): boolean {
  const code = extractSlackErrorCode(err);
  return code !== undefined && BENIGN_SLACK_FINALIZE_ERROR_CODES.has(code);
}

function extractSlackErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const record = err as Record<string, unknown>;
  // @slack/web-api errors expose `data.error` with the Slack error code.
  if (record.data && typeof record.data === "object") {
    const inner = (record.data as Record<string, unknown>).error;
    if (typeof inner === "string") {
      return inner;
    }
  }
  // Fallback: parse from message string ("An API error occurred: user_not_found").
  const message = typeof record.message === "string" ? record.message : "";
  const match = message.match(/An API error occurred:\s*([a-z_][a-z0-9_]*)/i);
  return match?.[1];
}

function formatSlackError(err: unknown): string {
  const code = extractSlackErrorCode(err);
  if (code) {
    return code;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
