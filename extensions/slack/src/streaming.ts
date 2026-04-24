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

import type { WebAPICallResult, WebClient } from "@slack/web-api";
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
  /**
   * True once any Slack API call (startStream / appendStream) has succeeded.
   * The SDK buffers appended text locally until the buffer exceeds
   * `buffer_size` (default 256 chars); only then does it issue a network
   * call. Until `delivered` flips, nothing has actually reached Slack.
   */
  delivered: boolean;
  /** Text accepted by the SDK but not yet acknowledged by Slack. */
  pendingText: string;
};

export type SlackStreamChunk =
  | {
      type: "markdown_text";
      markdown_text: string;
    }
  | {
      type: "task_update";
      id: string;
      title: string;
      status: "pending" | "in_progress" | "complete" | "completed" | "error";
    };

type SlackStreamTaskStatus = Extract<SlackStreamChunk, { type: "task_update" }>["status"];

export type SlackChunkStreamSession = {
  client: WebClient;
  channel: string;
  threadTs?: string;
  messageTs: string;
  stopped: boolean;
};

export type SlackPlanMessageSession = {
  client: WebClient;
  channel: string;
  messageTs: string;
  tasks: SlackPlanMessageTask[];
  revision: number;
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

export type StartSlackChunkStreamParams = {
  client: WebClient;
  channel: string;
  threadTs?: string;
  teamId?: string;
  userId?: string;
  taskDisplayMode?: "plan" | "task_update";
  chunks?: SlackStreamChunk[];
};

export type AppendSlackChunkStreamParams = {
  session: SlackChunkStreamSession;
  chunks: SlackStreamChunk[];
};

export type StopSlackChunkStreamParams = {
  session: SlackChunkStreamSession;
  chunks?: SlackStreamChunk[];
};

export type StartSlackPlanMessageParams = {
  client: WebClient;
  channel: string;
  chunks?: SlackStreamChunk[];
};

export type AppendSlackPlanMessageParams = {
  session: SlackPlanMessageSession;
  chunks: SlackStreamChunk[];
};

export type StopSlackPlanMessageParams = {
  session: SlackPlanMessageSession;
  chunks?: SlackStreamChunk[];
};

type SlackPlanMessageTask = {
  type: "task_card";
  task_id: string;
  title: string;
  status: "pending" | "in_progress" | "complete" | "error";
};

type SlackApiClient = WebClient & {
  apiCall: (method: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

/**
 * Thrown when Slack rejects a stream flush/finalize with a recipient-resolution
 * error (see {@link BENIGN_SLACK_FINALIZE_ERROR_CODES}) while text is still
 * only buffered locally by the Slack SDK. Carries the pending text so the
 * caller can deliver it via a normal `chat.postMessage`.
 */
export class SlackStreamNotDeliveredError extends Error {
  readonly pendingText: string;
  readonly slackCode: string;
  constructor(pendingText: string, slackCode: string) {
    super(
      `slack-stream: finalize failed with ${slackCode} before any text reached Slack ` +
        `(${pendingText.length} chars pending)`,
    );
    this.name = "SlackStreamNotDeliveredError";
    this.pendingText = pendingText;
    this.slackCode = slackCode;
  }
}

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
    delivered: false,
    pendingText: "",
  };

  if (text) {
    session.pendingText += text;
    // Slack SDK ChatStreamer keeps short markdown_text chunks in a local buffer
    // and returns null until buffer_size is reached. Only a non-null response
    // means Slack acknowledged startStream/appendStream.
    try {
      const result = await streamer.append({ markdown_text: text });
      if (result) {
        session.delivered = true;
        session.pendingText = "";
      }
      logVerbose(
        `slack-stream: appended initial text (${text.length} chars, ${result ? "flushed" : "buffered"})`,
      );
    } catch (err) {
      if (isBenignSlackFinalizeError(err) && session.pendingText) {
        throw new SlackStreamNotDeliveredError(
          session.pendingText,
          extractSlackErrorCode(err) ?? "unknown",
        );
      }
      throw err;
    }
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

  session.pendingText += text;
  try {
    // Same SDK contract as startSlackStream: null means local-only buffer,
    // non-null means Slack accepted the pending buffer and it is visible.
    const result = await session.streamer.append({ markdown_text: text });
    if (result) {
      session.delivered = true;
      session.pendingText = "";
    }
    logVerbose(`slack-stream: appended ${text.length} chars (${result ? "flushed" : "buffered"})`);
  } catch (err) {
    if (isBenignSlackFinalizeError(err) && session.pendingText) {
      throw new SlackStreamNotDeliveredError(
        session.pendingText,
        extractSlackErrorCode(err) ?? "unknown",
      );
    }
    throw err;
  }
}

/**
 * Stop (finalize) a Slack stream.
 *
 * After calling this the stream message becomes a normal Slack message.
 * Optionally include final text to append before stopping.
 *
 * If Slack's `chat.stopStream` responds with a known benign finalize error
 * (see {@link BENIGN_SLACK_FINALIZE_ERROR_CODES}) AND any prior `append`
 * has already landed on Slack, the error is swallowed and the session is
 * marked stopped - the already-delivered text stays visible.
 *
 * If the same benign error fires while text is still only buffered locally
 * (e.g. short replies that never exceeded the SDK's buffer_size), this
 * function throws a {@link SlackStreamNotDeliveredError} carrying that pending
 * text so the caller can deliver it via `chat.postMessage`.
 *
 * All other errors propagate unchanged.
 */
export async function stopSlackStream(params: StopSlackStreamParams): Promise<void> {
  const { session, text } = params;

  if (session.stopped) {
    logVerbose("slack-stream: stream already stopped, ignoring duplicate stop");
    return;
  }

  session.stopped = true;
  if (text) {
    session.pendingText += text;
  }

  logVerbose(
    `slack-stream: stopping stream in ${session.channel} thread=${session.threadTs}${
      text ? ` (final text: ${text.length} chars)` : ""
    }`,
  );

  try {
    await session.streamer.stop(text ? { markdown_text: text } : undefined);
    session.delivered = true;
    session.pendingText = "";
  } catch (err) {
    if (isBenignSlackFinalizeError(err)) {
      const code = extractSlackErrorCode(err) ?? "unknown";
      if (session.pendingText) {
        // stop() can be the first network call for short replies. If Slack
        // Connect rejects it, the user has not seen the SDK-buffered text yet.
        throw new SlackStreamNotDeliveredError(session.pendingText, code);
      }
      if (session.delivered) {
        logVerbose(
          `slack-stream: finalize rejected by Slack (${code}); prior appends delivered, treating stream as stopped`,
        );
        return;
      }
    }
    throw err;
  }

  logVerbose("slack-stream: stream stopped");
}

function resolveSlackStreamMessageTs(
  response: WebAPICallResult & { ts?: string; message_ts?: string },
): string {
  const ts = response.ts;
  if (typeof ts === "string" && ts.length > 0) {
    return ts;
  }
  const messageTs = response.message_ts;
  if (typeof messageTs === "string" && messageTs.length > 0) {
    return messageTs;
  }
  throw new TypeError("Slack stream response missing message timestamp");
}

function normalizeSlackPlanTaskStatus(
  status: SlackStreamTaskStatus,
): SlackPlanMessageTask["status"] {
  return status === "completed" ? "complete" : status;
}

function applySlackPlanTaskChunks(
  tasks: SlackPlanMessageTask[],
  chunks: SlackStreamChunk[] | undefined,
): SlackPlanMessageTask[] {
  if (!chunks?.length) {
    return tasks;
  }
  const nextTasks = [...tasks];
  for (const chunk of chunks) {
    if (chunk.type !== "task_update") {
      continue;
    }
    const existingIndex = nextTasks.findIndex((task) => task.task_id === chunk.id);
    const task: SlackPlanMessageTask = {
      type: "task_card",
      task_id: chunk.id,
      title: chunk.title,
      status: normalizeSlackPlanTaskStatus(chunk.status),
    };
    if (existingIndex >= 0) {
      nextTasks[existingIndex] = task;
    } else {
      nextTasks.push(task);
    }
  }
  return nextTasks;
}

function resolveSlackPlanMessageTitle(session: SlackPlanMessageSession): string {
  if (session.stopped) {
    return "Thinking completed";
  }
  const activeTask = session.tasks.find((task) => task.status === "in_progress");
  return activeTask?.title ?? "Working";
}

function buildSlackPlanMessageBlocks(session: SlackPlanMessageSession) {
  return [
    {
      type: "plan",
      block_id: `openclaw_progress_plan_${session.revision}`,
      title: resolveSlackPlanMessageTitle(session),
      tasks: session.tasks,
    },
  ];
}

export async function startSlackChunkStream(
  params: StartSlackChunkStreamParams,
): Promise<SlackChunkStreamSession> {
  const { client, channel, threadTs, teamId, userId, taskDisplayMode, chunks } = params;

  logVerbose(
    `slack-stream: starting chunk stream in ${channel}${threadTs ? ` thread=${threadTs}` : ""}${
      taskDisplayMode ? ` mode=${taskDisplayMode}` : ""
    }`,
  );

  const apiClient = client as SlackApiClient;
  const response = await apiClient.apiCall("chat.startStream", {
    channel,
    ...(threadTs ? { thread_ts: threadTs } : {}),
    ...(teamId ? { recipient_team_id: teamId } : {}),
    ...(userId ? { recipient_user_id: userId } : {}),
    ...(taskDisplayMode ? { task_display_mode: taskDisplayMode } : {}),
    ...(chunks?.length ? { chunks } : {}),
  });

  return {
    client,
    channel,
    threadTs,
    messageTs: resolveSlackStreamMessageTs(response),
    stopped: false,
  };
}

export async function appendSlackChunkStream(params: AppendSlackChunkStreamParams): Promise<void> {
  const { session, chunks } = params;
  if (session.stopped || chunks.length === 0) {
    return;
  }
  const apiClient = session.client as SlackApiClient;
  await apiClient.apiCall("chat.appendStream", {
    channel: session.channel,
    ...(session.threadTs ? { thread_ts: session.threadTs } : {}),
    ts: session.messageTs,
    chunks,
  });
}

export async function stopSlackChunkStream(params: StopSlackChunkStreamParams): Promise<void> {
  const { session, chunks } = params;
  if (session.stopped) {
    logVerbose("slack-stream: chunk stream already stopped, ignoring duplicate stop");
    return;
  }
  session.stopped = true;
  const apiClient = session.client as SlackApiClient;
  await apiClient.apiCall("chat.stopStream", {
    channel: session.channel,
    ...(session.threadTs ? { thread_ts: session.threadTs } : {}),
    ts: session.messageTs,
    ...(chunks?.length ? { chunks } : {}),
  });
}

export async function startSlackPlanMessage(
  params: StartSlackPlanMessageParams,
): Promise<SlackPlanMessageSession> {
  const { client, channel, chunks } = params;
  const apiClient = client as SlackApiClient;
  const session: SlackPlanMessageSession = {
    client,
    channel,
    messageTs: "",
    tasks: applySlackPlanTaskChunks([], chunks),
    revision: 1,
    stopped: false,
  };
  const response = await apiClient.apiCall("chat.postMessage", {
    channel,
    text: "Thinking...",
    blocks: buildSlackPlanMessageBlocks(session),
  });
  session.messageTs = resolveSlackStreamMessageTs(response);
  return session;
}

export async function appendSlackPlanMessage(params: AppendSlackPlanMessageParams): Promise<void> {
  const { session, chunks } = params;
  if (session.stopped || chunks.length === 0) {
    return;
  }
  session.tasks = applySlackPlanTaskChunks(session.tasks, chunks);
  session.revision += 1;
  const apiClient = session.client as SlackApiClient;
  await apiClient.apiCall("chat.update", {
    channel: session.channel,
    ts: session.messageTs,
    text: "Thinking...",
    blocks: buildSlackPlanMessageBlocks(session),
  });
}

export async function stopSlackPlanMessage(params: StopSlackPlanMessageParams): Promise<void> {
  const { session, chunks } = params;
  if (session.stopped) {
    return;
  }
  session.stopped = true;
  session.tasks = applySlackPlanTaskChunks(session.tasks, chunks);
  session.revision += 1;
  const apiClient = session.client as SlackApiClient;
  await apiClient.apiCall("chat.update", {
    channel: session.channel,
    ts: session.messageTs,
    text: "Thinking completed.",
    blocks: buildSlackPlanMessageBlocks(session),
  });
}

// ---------------------------------------------------------------------------
// Finalize error classification
// ---------------------------------------------------------------------------

/**
 * Slack API error codes that indicate `chat.stopStream` (or the
 * `chat.startStream` call the SDK issues inside `stop()` when the buffer
 * never flushed) cannot finalize the stream for the current recipient or
 * team. Either the caller falls back to a normal message (see
 * {@link SlackStreamNotDeliveredError}) or, if prior appends already
 * delivered text, the error is logged verbosely and swallowed.
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

export function isBenignSlackFinalizeError(err: unknown): boolean {
  const code = extractSlackErrorCode(err);
  return code !== undefined && BENIGN_SLACK_FINALIZE_ERROR_CODES.has(code);
}

export function extractSlackErrorCode(err: unknown): string | undefined {
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

export function markSlackStreamFallbackDelivered(session: SlackStreamSession): void {
  const hadNativeDelivery = session.delivered;
  session.pendingText = "";
  session.delivered = true;
  if (!hadNativeDelivery) {
    session.stopped = true;
  }
}
